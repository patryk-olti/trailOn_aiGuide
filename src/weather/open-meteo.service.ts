import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  OpenMeteoResponse,
  PeakWeatherForecastDay,
  PeakWeatherSnapshot,
  WeatherScope,
} from './open-meteo.types';

const WEATHER_CACHE_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const POLAND_TIME_ZONE = 'Europe/Warsaw';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

type CacheEntry<T> = { expiresAt: number; value: T };

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function polandCalendarParts(date = new Date()): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: POLAND_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    weekday: weekdayMap[pick('weekday')] ?? 0,
  };
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addCalendarDays(year: number, month: number, day: number, addDays: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + addDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function resolveWeekendForecastTarget(now = new Date()): {
  forecastDay: PeakWeatherForecastDay;
  forecastDate: string;
} {
  const { year, month, day, weekday } = polandCalendarParts(now);
  if (weekday === 0) {
    return {
      forecastDay: 'sunday',
      forecastDate: formatYmd(year, month, day),
    };
  }
  const daysUntilSaturday = (6 - weekday + 7) % 7;
  const target = addCalendarDays(year, month, day, daysUntilSaturday);
  return {
    forecastDay: 'saturday',
    forecastDate: formatYmd(target.year, target.month, target.day),
  };
}

@Injectable()
export class OpenMeteoService {
  private readonly logger = new Logger(OpenMeteoService.name);
  private readonly weatherCache = new Map<string, CacheEntry<PeakWeatherSnapshot>>();
  private readonly weekendWeatherCache = new Map<string, CacheEntry<PeakWeatherSnapshot>>();

  async getWeather(lat: number, lng: number, scope: WeatherScope = 'current'): Promise<PeakWeatherSnapshot> {
    if (scope === 'weekend') {
      return this.getWeekendWeather(lat, lng);
    }
    return this.getCurrentWeather(lat, lng);
  }

  private async getCurrentWeather(lat: number, lng: number): Promise<PeakWeatherSnapshot> {
    const key = cacheKey(lat, lng);
    const cached = this.weatherCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const query = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      timezone: 'auto',
    });

    try {
      const data = await this.fetchForecast(query);
      const current = data.current;
      if (
        !current?.time ||
        !finiteNumber(current.temperature_2m) ||
        !finiteNumber(current.apparent_temperature) ||
        !finiteNumber(current.relative_humidity_2m) ||
        !finiteNumber(current.precipitation) ||
        !finiteNumber(current.wind_speed_10m) ||
        !finiteNumber(current.weather_code)
      ) {
        throw new Error('Open-Meteo returned incomplete current conditions');
      }
      const value: PeakWeatherSnapshot = {
        observedAt: current.time,
        temperatureC: current.temperature_2m,
        apparentTemperatureC: current.apparent_temperature,
        humidityPercent: current.relative_humidity_2m,
        precipitationMm: current.precipitation,
        windSpeedKmh: current.wind_speed_10m,
        weatherCode: current.weather_code,
      };
      this.weatherCache.set(key, { value, expiresAt: Date.now() + WEATHER_CACHE_MS });
      return value;
    } catch (error) {
      if (cached) {
        return cached.value;
      }
      const message = error instanceof Error ? error.message : 'Weather service unavailable';
      this.logger.warn(`Open-Meteo (current): ${message}`);
      throw new ServiceUnavailableException(message);
    }
  }

  private async getWeekendWeather(lat: number, lng: number): Promise<PeakWeatherSnapshot> {
    const { forecastDay, forecastDate } = resolveWeekendForecastTarget();
    const key = `weekend:${cacheKey(lat, lng)}:${forecastDate}`;
    const cached = this.weekendWeatherCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const query = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      hourly:
        'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      timezone: POLAND_TIME_ZONE,
      start_date: forecastDate,
      end_date: forecastDate,
    });

    try {
      const data = await this.fetchForecast(query);
      const hourly = data.hourly;
      const times = hourly?.time ?? [];
      const noonPrefix = `${forecastDate}T12:`;
      let index = times.findIndex((time) => time.startsWith(noonPrefix));
      if (index < 0) {
        index = times.length > 0 ? Math.min(12, times.length - 1) : -1;
      }
      if (
        index < 0 ||
        !finiteNumber(hourly?.temperature_2m?.[index]) ||
        !finiteNumber(hourly?.apparent_temperature?.[index]) ||
        !finiteNumber(hourly?.relative_humidity_2m?.[index]) ||
        !finiteNumber(hourly?.precipitation?.[index]) ||
        !finiteNumber(hourly?.wind_speed_10m?.[index]) ||
        !finiteNumber(hourly?.weather_code?.[index])
      ) {
        throw new Error('Open-Meteo returned incomplete weekend hourly forecast');
      }

      const value: PeakWeatherSnapshot = {
        observedAt: times[index]!,
        temperatureC: hourly!.temperature_2m![index]!,
        apparentTemperatureC: hourly!.apparent_temperature![index]!,
        humidityPercent: hourly!.relative_humidity_2m![index]!,
        precipitationMm: hourly!.precipitation![index]!,
        windSpeedKmh: hourly!.wind_speed_10m![index]!,
        weatherCode: hourly!.weather_code![index]!,
        forecastDay,
        forecastDate,
      };
      this.weekendWeatherCache.set(key, { value, expiresAt: Date.now() + WEATHER_CACHE_MS });
      return value;
    } catch (error) {
      if (cached) {
        return cached.value;
      }
      const message = error instanceof Error ? error.message : 'Weather service unavailable';
      this.logger.warn(`Open-Meteo (weekend): ${message}`);
      throw new ServiceUnavailableException(message);
    }
  }

  private async fetchForecast(query: URLSearchParams): Promise<OpenMeteoResponse> {
    const response = await fetch(`${OPEN_METEO_FORECAST_URL}?${query}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo responded ${response.status}`);
    }
    return (await response.json()) as OpenMeteoResponse;
  }
}