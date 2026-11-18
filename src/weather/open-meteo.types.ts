export type PeakWeatherForecastDay = 'saturday' | 'sunday';

export type WeatherScope = 'current' | 'weekend';

export interface PeakWeatherSnapshot {
  observedAt: string;
  temperatureC: number;
  apparentTemperatureC: number;
  humidityPercent: number;
  precipitationMm: number;
  windSpeedKmh: number;
  weatherCode: number;
  forecastDay?: PeakWeatherForecastDay;
  forecastDate?: string;
}

type OpenMeteoResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    relative_humidity_2m?: number[];
    precipitation?: number[];
    wind_speed_10m?: number[];
    weather_code?: number[];
  };
};

export type { OpenMeteoResponse };