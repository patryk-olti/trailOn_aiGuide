import { ServiceUnavailableException } from '@nestjs/common';
import { D1Service } from '../cloudflare/d1.service';
import { PeakRow } from '../cloudflare/d1.types';
import { OpenMeteoService } from '../weather/open-meteo.service';
import { PeakWeatherSnapshot, WeatherScope } from '../weather/open-meteo.types';
import { weatherCodeLabelPl } from '../weather/weather-code.pl';
import { GuidePeakElevation, GuideToolResult } from './guide.types';

type ToolArgs = Record<string, unknown>;

/** Dopytanie o pogodę obejmuje tylko szczyty w tym promieniu od punktu użytkownika. */
export const WEATHER_NEARBY_RADIUS_KM = 5;
const EARTH_RADIUS_KM = 6371;
const NEARBY_PEAK_LIMIT = 8;

export interface WeatherUserPoint {
  lat: number;
  lng: number;
}

type NearbyPeak = PeakRow & { distance_km: number };

export async function runGetPeakWeather(
  args: ToolArgs,
  d1: D1Service,
  weather: OpenMeteoService,
  location?: WeatherUserPoint,
): Promise<GuideToolResult> {
  const scope = readWeatherScope(args.scope) ?? 'current';
  const peakId = readString(args.peak_id);
  const peakName = readString(args.peak_name);
  const lat = readFloat(args.lat);
  const lng = readFloat(args.lng);

  let peakLabel = '';
  let latLng: { lat: number; lng: number } | undefined;
  let resolvedPeaks: GuidePeakElevation[] = [];

  if (peakId) {
    const peak = await findPeakById(d1, peakId);
    if (!peak) {
      return unansweredWeather(
        d1,
        location,
        `Nie znaleziono opublikowanego szczytu o id ${peakId}.`,
      );
    }
    const coords = peakCoordinates(peak);
    if (!coords) {
      return unansweredWeather(
        d1,
        location,
        `Szczyt ${peak.name} nie ma współrzędnych w katalogu — nie da się pobrać pogody Open-Meteo.`,
        asElevations([peak]),
      );
    }
    latLng = coords;
    peakLabel = formatPeakLabel(peak);
    resolvedPeaks = asElevations([peak]);
  } else if (peakName) {
    const matches = await findPeaksByName(d1, peakName, 5);
    if (matches.length === 0) {
      return unansweredWeather(
        d1,
        location,
        `Brak opublikowanego szczytu pasującego do nazwy „${peakName}".`,
      );
    }
    const withCoords = matches.filter((row) => peakCoordinates(row) !== undefined);
    if (withCoords.length === 0) {
      return unansweredWeather(
        d1,
        location,
        `Znaleziono „${peakName}", ale brak współrzędnych w katalogu D1.`,
        asElevations(matches),
      );
    }
    const chosen = withCoords[0]!;
    resolvedPeaks = asElevations(withCoords);
    if (withCoords.length > 1) {
      const others = withCoords
        .slice(1, 4)
        .map((p) => `${p.name} (${p.elevation_m} m.n.p.m., ${p.range_name}, id=${p.peak_id})`)
        .join('; ');
      peakLabel = `${formatPeakLabel(chosen)} | Uwaga: inne trafienia: ${others}`;
    } else {
      peakLabel = formatPeakLabel(chosen);
    }
    latLng = peakCoordinates(chosen)!;
  } else if (lat !== undefined && lng !== undefined) {
    if (!isValidLatLng(lat, lng)) {
      return unansweredWeather(d1, location, 'Nieprawidłowe współrzędne lat/lng.');
    }
    latLng = { lat, lng };
    peakLabel = `Współrzędne ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } else {
    return unansweredWeather(
      d1,
      location,
      'Brak szczytu, do którego da się odnieść pogodę (nie podano peak_id, peak_name ani współrzędnych szczytu).',
    );
  }

  try {
    const snapshot = await weather.getWeather(latLng.lat, latLng.lng, scope);
    const text = formatWeatherText(peakLabel, snapshot, scope);
    return { text, sourceKeys: [], peaks: resolvedPeaks };
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
      peaks: resolvedPeaks,
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

export function formatUnansweredWeather(reason: string, nearby: NearbyPeak[] | undefined): string {
  const head = `${reason} Nie zgaduj prognozy.`;
  if (!nearby) {
    return (
      `${head} Brak punktu użytkownika, więc nie wskażę szczytów w okolicy. ` +
      'Poproś o włączenie lokalizacji w TrailOn albo o nazwę szczytu.'
    );
  }
  if (nearby.length === 0) {
    return (
      `${head} W promieniu ${WEATHER_NEARBY_RADIUS_KM} km od punktu nie ma szczytu ze współrzędnymi, ` +
      'do którego da się odnieść pogodę. Powiedz to wprost i poproś o nazwę szczytu. Nie poszerzaj promienia.'
    );
  }
  const lines = nearby.map((peak) => {
    const distance = Number.isFinite(peak.distance_km) ? `${peak.distance_km.toFixed(1)} km` : 'w promieniu 5 km';
    return `- ${peak.name} (${peak.elevation_m} m.n.p.m.) | pasmo: ${peak.range_name} | ${distance} | id=${peak.peak_id}`;
  });
  return (
    `${head} Dopytaj użytkownika, o który z tych szczytów chodzi. ` +
    `To jedyne szczyty w promieniu maksymalnie ${WEATHER_NEARBY_RADIUS_KM} km od jego punktu, do których możesz odnieść pogodę. ` +
    'Nie wymieniaj dalszych i nie podawaj prognozy, dopóki nie wskaże jednego z nich:\n' +
    lines.join('\n')
  );
}

async function unansweredWeather(
  d1: D1Service,
  location: WeatherUserPoint | undefined,
  reason: string,
  peaks: GuidePeakElevation[] = [],
): Promise<GuideToolResult> {
  const nearby = await nearbyPeaksForWeather(d1, location);
  return {
    text: formatUnansweredWeather(reason, nearby),
    sourceKeys: [],
    peaks: [...peaks, ...asElevations(nearby ?? [])],
  };
}

function asElevations(peaks: Array<{ name: string; elevation_m: number }>): GuidePeakElevation[] {
  return peaks.map((peak) => ({ name: peak.name, elevationM: peak.elevation_m }));
}

async function nearbyPeaksForWeather(
  d1: D1Service,
  location: WeatherUserPoint | undefined,
): Promise<NearbyPeak[] | undefined> {
  if (!location || !isValidLatLng(location.lat, location.lng)) {
    return undefined;
  }
  const table = d1.assertTableName(d1.peaksTable);
  const haversineKm = `(${EARTH_RADIUS_KM} * acos(min(1.0, max(-1.0,
    cos(radians(?)) * cos(radians(lat)) * cos(radians(lng) - radians(?)) + sin(radians(?)) * sin(radians(lat))
  ))))`;
  const sql = `SELECT peak_id, name, elevation_m, range_name, lat, lng, tags_json, description, status, recommended, distance_km
    FROM (
      SELECT peak_id, name, elevation_m, range_name, lat, lng, tags_json, description, status, recommended,
        ${haversineKm} AS distance_km
      FROM ${table}
      WHERE status = 'published' AND lat IS NOT NULL AND lng IS NOT NULL
    )
    WHERE distance_km <= ?
    ORDER BY distance_km ASC, elevation_m DESC
    LIMIT ?`;
  const rows = await d1.query<NearbyPeak>(sql, [
    location.lat,
    location.lng,
    location.lat,
    WEATHER_NEARBY_RADIUS_KM,
    NEARBY_PEAK_LIMIT,
  ]);
  return rows.filter((peak) => {
    const distance = typeof peak.distance_km === 'number' ? peak.distance_km : Number(peak.distance_km);
    return peakCoordinates(peak) !== undefined && Number.isFinite(distance) && distance <= WEATHER_NEARBY_RADIUS_KM;
  }).map((peak) => ({
    ...peak,
    distance_km: typeof peak.distance_km === 'number' ? peak.distance_km : Number(peak.distance_km),
  }));
}

function formatPeakLabel(peak: PeakRow): string {
  return `${peak.name} (${peak.elevation_m} m.n.p.m.) | pasmo: ${peak.range_name} | id=${peak.peak_id}`;
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