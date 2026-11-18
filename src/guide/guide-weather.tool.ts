import { ServiceUnavailableException } from '@nestjs/common';
import { D1Service } from '../cloudflare/d1.service';
import { PeakRow } from '../cloudflare/d1.types';
import { OpenMeteoService } from '../weather/open-meteo.service';
import { PeakWeatherSnapshot, WeatherScope } from '../weather/open-meteo.types';
import { weatherCodeLabelPl } from '../weather/weather-code.pl';
import { GuideToolResult } from './guide.types';

type ToolArgs = Record<string, unknown>;

export async function runGetPeakWeather(
  args: ToolArgs,
  d1: D1Service,
  weather: OpenMeteoService,
): Promise<GuideToolResult> {
  const scope = readWeatherScope(args.scope) ?? 'current';
  const peakId = readString(args.peak_id);
  const peakName = readString(args.peak_name);
  const lat = readFloat(args.lat);
  const lng = readFloat(args.lng);

  let peakLabel = '';
  let latLng: { lat: number; lng: number } | undefined;

  if (peakId) {
    const peak = await findPeakById(d1, peakId);
    if (!peak) {
      return { text: `Nie znaleziono opublikowanego szczytu o id ${peakId}.`, sourceKeys: [] };
    }
    const coords = peakCoordinates(peak);
    if (!coords) {
      return {
        text: `Szczyt ${peak.name} nie ma współrzędnych w katalogu — nie da się pobrać pogody Open-Meteo.`,
        sourceKeys: [],
      };
    }
    latLng = coords;
    peakLabel = formatPeakLabel(peak);
  } else if (peakName) {
    const matches = await findPeaksByName(d1, peakName, 5);
    if (matches.length === 0) {
      return {
        text: `Brak opublikowanego szczytu pasującego do nazwy „${peakName}".`,
        sourceKeys: [],
      };
    }
    const withCoords = matches.filter((row) => peakCoordinates(row) !== undefined);
    if (withCoords.length === 0) {
      return {
        text: `Znaleziono „${peakName}", ale brak współrzędnych w katalogu D1.`,
        sourceKeys: [],
      };
    }
    const chosen = withCoords[0]!;
    if (withCoords.length > 1) {
      const others = withCoords
        .slice(1, 4)
        .map((p) => `${p.name} (${p.range_name}, id=${p.peak_id})`)
        .join('; ');
      peakLabel = `${formatPeakLabel(chosen)} | Uwaga: inne trafienia: ${others}`;
    } else {
      peakLabel = formatPeakLabel(chosen);
    }
    latLng = peakCoordinates(chosen)!;
  } else if (lat !== undefined && lng !== undefined) {
    if (!isValidLatLng(lat, lng)) {
      return { text: 'Nieprawidłowe współrzędne lat/lng.', sourceKeys: [] };
    }
    latLng = { lat, lng };
    peakLabel = `Współrzędne ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } else {
    return {
      text:
        'Podaj peak_id, peak_name albo parę lat + lng (współrzędne szczytu z katalogu). ' +
        'Opcjonalnie scope: "current" (teraz) lub "weekend" (prognoza na najbliższą sobotę lub niedzielę — jak w TrailOn).',
      sourceKeys: [],
    };
  }

  try {
    const snapshot = await weather.getWeather(latLng.lat, latLng.lng, scope);
    const text = formatWeatherText(peakLabel, snapshot, scope);
    return { text, sourceKeys: [] };
  } catch (error) {
    const detail =
      error instanceof ServiceUnavailableException
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Open-Meteo niedostępne';
    return {
      text: `Nie udało się pobrać pogody (Open-Meteo, jak w aplikacji TrailOn): ${detail}`,
      sourceKeys: [],
    };
  }
}

function formatWeatherText(peakLabel: string, snapshot: PeakWeatherSnapshot, scope: WeatherScope): string {
  const scopeLabel =
    scope === 'weekend'
      ? `prognoza weekend (${snapshot.forecastDay === 'sunday' ? 'niedziela' : 'sobota'} ${snapshot.forecastDate ?? ''}, ok. południe)`
      : 'warunki aktualne (model bieżący)';
  const lines = [
    `${peakLabel} — ${scopeLabel}`,
    `Czas danych: ${snapshot.observedAt}`,
    `Temperatura: ${round1(snapshot.temperatureC)}°C (odczuwalna ${round1(snapshot.apparentTemperatureC)}°C)`,
    `Wiatr: ${round1(snapshot.windSpeedKmh)} km/h`,
    `Wilgotność: ${Math.round(snapshot.humidityPercent)}%`,
    `Opady w tym kroku modelu: ${round1(snapshot.precipitationMm)} mm`,
    `Zachmurzenie / opady (WMO ${snapshot.weatherCode}): ${weatherCodeLabelPl(snapshot.weatherCode)}`,
    'Źródło: Open-Meteo (api.open-meteo.com) — ten sam model co karta pogody na szczycie w TrailOn.',
  ];
  return lines.join('\n');
}

function formatPeakLabel(peak: PeakRow): string {
  return `${peak.name} (${peak.elevation_m} m, ${peak.range_name}, id=${peak.peak_id})`;
}

async function findPeakById(d1: D1Service, peakId: string): Promise<PeakRow | undefined> {
  const table = d1.assertTableName(d1.peaksTable);
  const rows = await d1.query<PeakRow>(
    `SELECT peak_id, name, elevation_m, range_name, lat, lng, tags_json, description, status, recommended
     FROM ${table} WHERE peak_id = ? AND status = 'published' LIMIT 1`,
    [peakId],
  );
  return rows[0];
}

async function findPeaksByName(d1: D1Service, name: string, limit: number): Promise<PeakRow[]> {
  const table = d1.assertTableName(d1.peaksTable);
  return d1.query<PeakRow>(
    `SELECT peak_id, name, elevation_m, range_name, lat, lng, tags_json, description, status, recommended
     FROM ${table} WHERE status = 'published' AND name LIKE ?
     ORDER BY recommended DESC, elevation_m DESC
     LIMIT ?`,
    [`%${name}%`, limit],
  );
}

function peakCoordinates(peak: PeakRow): { lat: number; lng: number } | undefined {
  if (!finiteNumber(peak.lat) || !finiteNumber(peak.lng)) {
    return undefined;
  }
  return { lat: peak.lat, lng: peak.lng };
}

function readWeatherScope(value: unknown): WeatherScope | undefined {
  const raw = readString(value);
  if (raw === 'current' || raw === 'weekend') {
    return raw;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFloat(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function round1(value: number): string {
  return value.toFixed(1);
}