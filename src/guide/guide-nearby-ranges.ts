import { D1Service } from '../cloudflare/d1.service';
import { RAG_SOURCE_LOCATIONS } from '../rag/rag.constants';
import {
  extractLooseRange,
  extractMountainRange,
  placeAskedAbout,
} from './guide-catalog.prefetch';
import { GuideToolResult } from './guide.types';

/** Najwyżej tyle pasm w jednej propozycji wyjazdu. */
export const MAX_NEARBY_RANGES = 3;
const EARTH_RADIUS_KM = 6371;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const GEOCODE_TIMEOUT_MS = 8_000;

export interface RangePeakDistance {
  peak_id: string;
  name: string;
  elevation_m: number;
  range_name: string;
  distance_km: number;
}

export interface GeocodeHit {
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
}

export type DeparturePlace =
  | {
      kind: 'ready';
      lat: number;
      lng: number;
      locality: string;
      voivodeship: string;
      assumption?: string;
    }
  | { kind: 'need_voivodeship'; locality: string; voivodeships: string[] }
  | { kind: 'unknown_voivodeship'; given: string }
  | { kind: 'not_found'; locality: string; voivodeship?: string; elsewhere: string[] };

type ToolArgs = Record<string, unknown>;

interface GuideCopy {
  instruction: string;
  reply: string;
}

const VOIVODESHIPS: Array<{ name: string; keys: string[] }> = [
  { name: 'dolnośląskie', keys: ['dolnoslaskie', 'dolny slask'] },
  { name: 'kujawsko-pomorskie', keys: ['kujawsko pomorskie'] },
  { name: 'lubelskie', keys: ['lubelskie'] },
  { name: 'lubuskie', keys: ['lubuskie'] },
  { name: 'łódzkie', keys: ['lodzkie'] },
  { name: 'małopolskie', keys: ['malopolskie', 'malopolska'] },
  { name: 'mazowieckie', keys: ['mazowieckie', 'mazowsze'] },
  { name: 'opolskie', keys: ['opolskie'] },
  { name: 'podkarpackie', keys: ['podkarpackie', 'podkarpacie'] },
  { name: 'podlaskie', keys: ['podlaskie', 'podlasie'] },
  { name: 'pomorskie', keys: ['pomorskie'] },
  { name: 'śląskie', keys: ['slaskie', 'slask'] },
  { name: 'świętokrzyskie', keys: ['swietokrzyskie'] },
  { name: 'warmińsko-mazurskie', keys: ['warminsko mazurskie'] },
  { name: 'wielkopolskie', keys: ['wielkopolskie', 'wielkopolska'] },
  { name: 'zachodniopomorskie', keys: ['zachodniopomorskie'] },
];

const VOIVODESHIP_KEYS = VOIVODESHIPS.flatMap((entry) =>
  entry.keys.map((key) => ({ name: entry.name, key })),
).sort((left, right) => right.key.length - left.key.length);

export function foldPolish(input: string): string {
  return input
    .toLowerCase()
    .replaceAll('ą', 'a')
    .replaceAll('ć', 'c')
    .replaceAll('ę', 'e')
    .replaceAll('ł', 'l')
    .replaceAll('ń', 'n')
    .replaceAll('ó', 'o')
    .replaceAll('ś', 's')
    .replaceAll('ż', 'z')
    .replaceAll('ź', 'z');
}

export function normalizePlaceLabel(input: string): string {
  return foldPolish(input)
    .replace(/\bwojewodztwo\b/g, ' ')
    .replace(/\bwoj\b/g, ' ')
    .replace(/\bvoivodeship\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function canonicalVoivodeship(input: string): string | undefined {
  const key = normalizePlaceLabel(input);
  if (!key) {
    return undefined;
  }
  return VOIVODESHIP_KEYS.find((entry) => entry.key === key)?.name;
}

export function mentionedVoivodeship(message: string): string | undefined {
  const haystack = ` ${normalizePlaceLabel(message)} `;
  return VOIVODESHIP_KEYS.find((entry) => haystack.includes(` ${entry.key} `))?.name;
}

export function messageGivesDeparturePlace(message: string): boolean {
  if (!mentionedVoivodeship(message)) {
    return false;
  }
  return (
    /,\s*\p{L}/u.test(message) ||
    /\b(?:z|ze|od)\s+[a-ząćęłńóśźżA-ZĄĆĘŁŃÓŚŹŻ][\p{L}'’-]+/u.test(message)
  );
}

/** Pytanie o konkretne pasmo albo szczyt, a nie o „gdzie jechać w góry”. */
export function messageTargetsSpecificPlace(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  return Boolean(extractMountainRange(trimmed) || extractLooseRange(trimmed) || placeAskedAbout(trimmed));
}

export function messageWantsRangeSuggestion(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || messageTargetsSpecificPlace(trimmed)) {
    return false;
  }
  const mountains =
    /(?:^|[^\p{L}])(góry|górach|górom|górami|górę|górsk\p{L}*|gory|gorach|gorom|gorami|gorsk\p{L}*)/iu.test(
      trimmed,
    );
  if (!mountains) {
    return false;
  }
  return /pojech|jad[eę]|wyjech|wypraw|wybier|rusz|proponuj|pole[cć]|dok[aą]d|gdzie|chc[eę]/i.test(
    trimmed,
  );
}

const NOT_A_PLACE = new Set([
  'gory',
  'gorach',
  'pogoda',
  'szczyt',
  'szlak',
  'trasa',
  'tak',
  'nie',
  'hej',
  'dzieki',
  'dziekuje',
  'weekend',
  'jutro',
]);

function barePlaceText(message: string): string {
  return message
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/^(?:a|to|no|ok|okej)\s+/iu, '')
    .trim();
}

/** Sama miejscowość, odpowiedź na pytanie „skąd jedziesz”. */
export function bareLocalityMessage(message: string): boolean {
  const trimmed = barePlaceText(message);
  if (/^(?:z|ze|od)\s+[\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2}$/iu.test(trimmed)) {
    return true;
  }
  return /^[\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2}$/iu.test(trimmed);
}

/**
 * Użytkownik sam zmienia punkt startu.
 * Nazwa szczytu albo pasma w pytaniu „co jest przy…” startu nie zmienia.
 */
export function messageReplacesDeparture(message: string, placeAnswerExpected = false): boolean {
  if (messageTargetsSpecificPlace(message)) {
    return false;
  }
  if (messageGivesDeparturePlace(message)) {
    return true;
  }
  if (/\b(?:jad[eę]|wyjeżdżam|wyjezdzam|start(?:uję|uje)?|licz(?:ę|e)?|ruszam)\s+(?:z|ze|od)\b/iu.test(message)) {
    return true;
  }
  if (!bareLocalityMessage(message)) {
    return false;
  }
  const raw = barePlaceText(message).replace(/^(?:z|ze|od)\s+/iu, '');
  if (NOT_A_PLACE.has(foldPolish(raw))) {
    return false;
  }
  if (placeAnswerExpected) {
    return true;
  }
  return /^[\p{Lu}]/u.test(raw) || /^(?:z|ze|od)\s+/iu.test(barePlaceText(message));
}

/** Lista najbliższych pasm tylko przy otwartym „dokąd w góry” albo przy podaniu startu. */
export function messageAllowsNearbyList(message: string, placeAnswerExpected = false): boolean {
  if (messageTargetsSpecificPlace(message)) {
    return false;
  }
  if (messageWantsRangeSuggestion(message)) {
    return true;
  }
  if (messageReplacesDeparture(message, placeAnswerExpected)) {
    return true;
  }
  const words = message.trim().split(/\s+/).filter(Boolean);
  return mentionedVoivodeship(message) !== undefined && words.length > 0 && words.length <= 4;
}

export function isNearbyRangesTemplate(text: string): boolean {
  return /Najbliższe pasma — odległość w linii prostej/.test(text);
}

export function assistantAskedForDeparture(contents: string[]): boolean {
  return contents.some(
    (content) => /województw/i.test(content) && /miejscowoś/i.test(content),
  );
}

export interface StatedDeparture {
  locality: string;
  voivodeship: string;
}

/**
 * Miejscowość razem z województwem z jednej wypowiedzi.
 * Potwierdzenie „Liczę od Kraków (woj. małopolskie)” jest pewniejsze niż odmiana z wiadomości użytkownika.
 */
export function statedDepartureFromText(text: string): StatedDeparture | undefined {
  const confirmed = [...text.matchAll(
    /([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,2})\s*\(\s*woj(?:ewództwo)?\.?\s+([^)]+)\)/gu,
  )].at(-1);
  const confirmedPlace = departurePair(confirmed?.[1], confirmed?.[2]);
  if (confirmedPlace) {
    return confirmedPlace;
  }

  const voivodeship = mentionedVoivodeship(text);
  if (!voivodeship || !messageGivesDeparturePlace(text)) {
    return undefined;
  }
  return departurePair(localityBesideVoivodeship(text), voivodeship);
}

/** Ostatnie miejsce startu w wątku. Nowsza wypowiedź zastępuje starszą. Wiadomość bez miejsca nic nie zmienia. */
export function latestStatedDeparture(texts: readonly string[]): StatedDeparture | undefined {
  let found: StatedDeparture | undefined;
  for (const text of texts) {
    const stated = statedDepartureFromText(text);
    if (stated) {
      found = stated;
    }
  }
  return found;
}

function departurePair(locality: string | undefined, voivodeship: string | undefined): StatedDeparture | undefined {
  const place = locality?.trim();
  const region = voivodeship ? canonicalVoivodeship(voivodeship) : undefined;
  if (!place || !region || canonicalVoivodeship(place)) {
    return undefined;
  }
  return { locality: place, voivodeship: region };
}

function localityBesideVoivodeship(message: string): string | undefined {
  const from = message.match(
    /\b(?:z|ze|od)\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/u,
  );
  const fromPlace = cleanPlaceToken(from?.[1]);
  if (fromPlace) {
    return fromPlace;
  }
  const comma = message.match(
    /(?:^|[^\p{L}])([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,2})\s*,\s*(?:woj(?:ewództwo)?\.?\s*)?/u,
  );
  return cleanPlaceToken(comma?.[1]);
}

function cleanPlaceToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = cleanLocality(value);
  if (!cleaned || canonicalVoivodeship(cleaned)) {
    return undefined;
  }
  return cleaned;
}

export function takeNearestRanges(rows: RangePeakDistance[], limit: number): RangePeakDistance[] {
  const capped = Math.max(1, Math.min(MAX_NEARBY_RANGES, limit));
  const best = new Map<string, RangePeakDistance>();
  for (const row of rows) {
    const range = row.range_name?.trim();
    const distance = Number(row.distance_km);
    const elevation = Number(row.elevation_m);
    if (!range || !row.name?.trim() || !row.peak_id || !Number.isFinite(distance) || !Number.isFinite(elevation)) {
      continue;
    }
    const candidate: RangePeakDistance = {
      peak_id: row.peak_id,
      name: row.name.trim(),
      elevation_m: Math.round(elevation),
      range_name: range,
      distance_km: distance,
    };
    const current = best.get(range);
    if (!current || candidate.distance_km < current.distance_km) {
      best.set(range, candidate);
    }
  }
  return [...best.values()]
    .sort((left, right) => left.distance_km - right.distance_km || left.range_name.localeCompare(right.range_name, 'pl'))
    .slice(0, capped);
}

export function resolveDeparturePlace(
  hits: GeocodeHit[],
  locality: string,
  voivodeship: string | undefined,
): DeparturePlace {
  const placeName = cleanLocality(locality);
  const exact = hits.filter(
    (hit) =>
      hit.country_code === 'PL' &&
      isValidLatLng(hit.latitude, hit.longitude) &&
      sameLocality(hit.name, placeName),
  );
  const asked = voivodeship ? canonicalVoivodeship(voivodeship) : undefined;
  if (voivodeship?.trim() && !asked) {
    return { kind: 'unknown_voivodeship', given: voivodeship.trim() };
  }

  if (exact.length === 0) {
    return { kind: 'not_found', locality: placeName, voivodeship: asked, elsewhere: [] };
  }

  if (!asked) {
    const voivodeships = uniqueVoivodeships(exact);
    if (voivodeships.length !== 1) {
      return { kind: 'need_voivodeship', locality: displayName(exact, placeName), voivodeships };
    }
    const only = voivodeships[0]!;
    const inVoivodeship = exact.filter((hit) => canonicalVoivodeship(hit.admin1 ?? '') === only);
    const chosen = pickMostPopulous(inVoivodeship);
    return readyPlace(chosen, chosen.name, only, inVoivodeship.length > 1);
  }

  const matched = exact.filter((hit) => canonicalVoivodeship(hit.admin1 ?? '') === asked);
  if (matched.length === 0) {
    return {
      kind: 'not_found',
      locality: displayName(exact, placeName),
      voivodeship: asked,
      elsewhere: uniqueVoivodeships(exact),
    };
  }
  const chosen = pickMostPopulous(matched);
  return readyPlace(chosen, chosen.name, asked, matched.length > 1);
}

export function formatAskForOrigin(): GuideCopy {
  return {
    instruction:
      'Brak snapshotu GPS w żądaniu. Nie wymieniaj pasm i nie zgaduj miejscowości. Przekaż prośbę o lokalizację albo o miejscowość razem z województwem.',
    reply:
      'Żebym mógł zaproponować konkretne pasma, a nie strzelać, potrzebuję punktu startu.\n\n' +
      'Włącz lokalizację w TrailOn — zrobię snapshot GPS i wskażę dwa albo trzy najbliższe pasma oraz ile kilometrów jest do szczytu w każdym.\n\n' +
      'Jeśli nie chcesz podawać GPS, napisz, skąd jedziesz: miejscowość i województwo. Ta sama miejscowość leży często w kilku województwach, więc samo miasto nie wystarczy.',
  };
}

export function formatNeedVoivodeship(locality: string, voivodeships: string[]): GuideCopy {
  if (voivodeships.length === 0) {
    return {
      instruction: `Nie mam województwa przy „${locality}”. Nie licz odległości. Dopytaj o województwo.`,
      reply: `Żeby policzyć odległość od „${locality}”, napisz jeszcze województwo. Ta sama miejscowość leży często w kilku.`,
    };
  }
  const listed = voivodeships.join(', ');
  return {
    instruction: `Miejscowość występuje w kilku województwach (${listed}). Nie wybieraj jednego i nie licz odległości. Dopytaj o województwo, potem wywołaj suggest_nearby_ranges z locality i voivodeship.`,
    reply: `„${locality}” leży w kilku województwach: ${listed}. Napisz, które województwo — wtedy policzę odległość do najbliższych pasm. Samej miejscowości nie wystarczy.`,
  };
}

export function formatUnknownVoivodeship(given: string): GuideCopy {
  const names = VOIVODESHIPS.map((entry) => entry.name).join(', ');
  return {
    instruction: `Nie rozpoznaję województwa „${given}”. Nie licz odległości. Poproś o jedno z 16 województw.`,
    reply: `Nie rozpoznaję województwa „${given}”. Napisz jedno z tych: ${names}. Do miejscowości potrzebne jest województwo, bo ta sama nazwa bywa w kilku.`,
  };
}

export function formatPlaceNotFound(place: Extract<DeparturePlace, { kind: 'not_found' }>): GuideCopy {
  if (place.voivodeship && place.elsewhere.length > 0) {
    return {
      instruction: `Brak „${place.locality}” w woj. ${place.voivodeship}. Jest w: ${place.elsewhere.join(', ')}. Nie licz odległości od innego województwa.`,
      reply: `Nie znajduję „${place.locality}” w woj. ${place.voivodeship}. Ta nazwa jest w: ${place.elsewhere.join(', ')}. Napisz, o które województwo chodzi.`,
    };
  }
  const where = place.voivodeship ? ` w woj. ${place.voivodeship}` : '';
  return {
    instruction: `Geokoder nie znalazł miejscowości „${place.locality}”${where} w Polsce. Nie zgaduj współrzędnych ani pasm.`,
    reply: `Nie znajduję miejscowości „${place.locality}”${where}. Napisz nazwę jeszcze raz, razem z województwem.`,
  };
}

export function formatNearbyRanges(origin: string, ranges: RangePeakDistance[], assumption?: string): GuideCopy {
  if (ranges.length === 0) {
    return {
      instruction: 'Katalog nie zwrócił szczytów ze współrzędnymi dla tego punktu. Nie wymyślaj pasm ani kilometrów.',
      reply: `Od ${origin} nie znajduję w katalogu trailON szczytów ze współrzędnymi, więc nie podam odległości na oko.`,
    };
  }
  const facts = ranges
    .map((range, index) => {
      const km = formatKm(range.distance_km);
      return `${index + 1}. ${range.range_name} — ${km} km do ${range.name} (${range.elevation_m} m.n.p.m., id=${range.peak_id})`;
    })
    .join('\n');
  const bullets = ranges
    .map((range) => {
      const km = formatKm(range.distance_km);
      return `- **${range.range_name}** — około ${km} km do ${range.name} (${range.elevation_m} m.n.p.m.)`;
    })
    .join('\n');
  const assumptionLine = assumption ? `${assumption}\n\n` : '';
  return {
    instruction:
      'Przepisz użytkownikowi tylko te pasma. Nie dodawaj innych z pamięci i nie zmieniaj kilometrów ani nazw szczytów. To odległość w linii prostej do najbliższego szczytu w paśmie.\n' +
      facts,
    reply:
      `${assumptionLine}Liczę od ${origin}. Najbliższe pasma — odległość w linii prostej do szczytu w paśmie:\n\n` +
      `${bullets}\n\n` +
      'Które pasmo bierzemy na warsztat?',
  };
}

export function fillDepartureArgs(
  args: { locality?: unknown; voivodeship?: unknown },
  departure?: StatedDeparture,
): { locality?: string; voivodeship?: string } {
  const locality = readString(args.locality);
  const voivodeship = readString(args.voivodeship);
  if (!departure) {
    return { locality, voivodeship };
  }
  if (!locality) {
    return { locality: departure.locality, voivodeship: voivodeship ?? departure.voivodeship };
  }
  if (!voivodeship && normalizePlaceLabel(locality) === normalizePlaceLabel(departure.locality)) {
    return { locality, voivodeship: departure.voivodeship };
  }
  return { locality, voivodeship };
}

export async function coordinatesForDeparture(
  departure: StatedDeparture,
  signal?: AbortSignal,
): Promise<{ lat: number; lng: number } | undefined> {
  const place = resolveDeparturePlace(
    await geocodeLocality(departure.locality, signal),
    departure.locality,
    departure.voivodeship,
  );
  if (place.kind !== 'ready') {
    return undefined;
  }
  return { lat: place.lat, lng: place.lng };
}

export async function runSuggestNearbyRanges(
  args: ToolArgs,
  d1: D1Service,
  location: { lat: number; lng: number } | undefined,
  signal?: AbortSignal,
  departure?: StatedDeparture,
  userMessage?: string,
  placeAnswerExpected = false,
): Promise<GuideToolResult> {
  if (userMessage && !messageAllowsNearbyList(userMessage, placeAnswerExpected)) {
    return specificTargetRefusal(departure);
  }

  const limit = clampLimit(args.limit);
  const filled = fillDepartureArgs(args, departure);
  let locality = filled.locality;
  let voivodeship = filled.voivodeship;
  if (
    departure &&
    locality &&
    normalizePlaceLabel(locality) !== normalizePlaceLabel(departure.locality) &&
    (!userMessage || !messageReplacesDeparture(userMessage, placeAnswerExpected))
  ) {
    locality = departure.locality;
    voivodeship = departure.voivodeship;
  }

  try {
    if (locality) {
      const place = resolveDeparturePlace(await geocodeLocality(locality, signal), locality, voivodeship);
      return await answerFromPlace(place, d1, limit);
    }
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
      throw error;
    }
    return copyResult(
      {
        instruction: 'Geokoder miejscowości niedostępny. Poproś, aby powtórzył miejscowość i województwo. Nie zgaduj pasm.',
        reply:
          'Nie udało mi się ustalić tej miejscowości na mapie. Napisz jeszcze raz, skąd jedziesz: miejscowość i województwo.',
      },
      [],
    );
  }

  if (location && isValidLatLng(location.lat, location.lng)) {
    try {
      const ranges = await nearestRangePeaks(d1, location.lat, location.lng, limit);
      return copyResult(formatNearbyRanges('Twojej pozycji (snapshot GPS)', ranges), ranges);
    } catch (error) {
      if (error instanceof Error && /abort/i.test(error.name)) {
        throw error;
      }
      return catalogFailure();
    }
  }

  return copyResult(formatAskForOrigin(), []);
}

export async function geocodeLocality(locality: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const collected: GeocodeHit[] = [];
  for (const query of localityQueries(locality)) {
    const hits = await fetchGeocodeHits(query, signal);
    collected.push(...hits);
    if (hits.some((hit) => hit.country_code === 'PL' && sameLocality(hit.name, locality))) {
      return collected;
    }
  }
  return collected;
}

export function localityQueries(locality: string): string[] {
  const primary = cleanLocality(locality);
  const queries: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !queries.some((query) => normalizePlaceLabel(query) === normalizePlaceLabel(trimmed))) {
      queries.push(trimmed);
    }
  };
  push(primary);
  const words = primary.split(/\s+/).filter(Boolean);
  if (words.length === 1 && /a$/i.test(primary) && primary.length > 4) {
    push(primary.slice(0, -1));
  }
  if (words.length === 2) {
    let first = words[0] ?? '';
    let second = words[1] ?? '';
    if (/ego$/i.test(first) && first.length > 3) {
      first = `${first.slice(0, -3)}y`;
    }
    if (/u$/i.test(second) && second.length > 3) {
      second = second.slice(0, -1);
    }
    push(`${first} ${second}`);
  }
  return queries;
}

async function fetchGeocodeHits(name: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const query = new URLSearchParams({
    name,
    count: '20',
    language: 'pl',
    format: 'json',
  });
  const timeout = AbortSignal.timeout(GEOCODE_TIMEOUT_MS);
  const response = await fetch(`${GEOCODE_URL}?${query}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Geokoder odpowiedział ${response.status}`);
  }
  const payload = (await response.json()) as { results?: unknown };
  if (!Array.isArray(payload.results)) {
    return [];
  }
  return payload.results.flatMap((row) => {
    const hit = readGeocodeHit(row);
    return hit ? [hit] : [];
  });
}

async function answerFromPlace(
  place: DeparturePlace,
  d1: D1Service,
  limit: number,
): Promise<GuideToolResult> {
  if (place.kind === 'need_voivodeship') {
    return copyResult(formatNeedVoivodeship(place.locality, place.voivodeships), []);
  }
  if (place.kind === 'unknown_voivodeship') {
    return copyResult(formatUnknownVoivodeship(place.given), []);
  }
  if (place.kind === 'not_found') {
    return copyResult(formatPlaceNotFound(place), []);
  }
  try {
    const ranges = await nearestRangePeaks(d1, place.lat, place.lng, limit);
    const origin = `${place.locality} (woj. ${place.voivodeship})`;
    return copyResult(formatNearbyRanges(origin, ranges, place.assumption), ranges);
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
      throw error;
    }
    return catalogFailure();
  }
}

async function nearestRangePeaks(
  d1: D1Service,
  lat: number,
  lng: number,
  limit: number,
): Promise<RangePeakDistance[]> {
  const table = d1.assertTableName(d1.peaksTable);
  const haversineKm = `(${EARTH_RADIUS_KM} * acos(min(1.0, max(-1.0,
    cos(radians(?)) * cos(radians(lat)) * cos(radians(lng) - radians(?)) + sin(radians(?)) * sin(radians(lat))
  ))))`;
  const sql = `SELECT range_name, peak_id, name, elevation_m, distance_km
    FROM (
      SELECT range_name, peak_id, name, elevation_m, distance_km,
        ROW_NUMBER() OVER (
          PARTITION BY range_name
          ORDER BY distance_km ASC, elevation_m DESC
        ) AS range_rank
      FROM (
        SELECT peak_id, name, elevation_m, range_name,
          ${haversineKm} AS distance_km
        FROM ${table}
        WHERE status = 'published'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND range_name IS NOT NULL
          AND trim(range_name) != ''
      )
    )
    WHERE range_rank = 1
    ORDER BY distance_km ASC
    LIMIT ?`;
  const rows = await d1.query<RangePeakDistance>(sql, [lat, lng, lat, limit]);
  return takeNearestRanges(rows, limit);
}

export function formatRangesBesideReply(
  anchor: { range_name: string; name: string; elevation_m: number },
  neighbors: RangePeakDistance[],
  departure?: StatedDeparture,
): string {
  const lines = neighbors
    .map((range) => {
      const km = formatKm(range.distance_km);
      return `- **${range.range_name}** — około ${km} km do ${range.name} (${range.elevation_m} m.n.p.m.)`;
    })
    .join('\n');
  const start = startStays(departure);
  return (
    `${start}Obok pasma ${anchor.range_name} (liczone od szczytu ${anchor.name}, ${anchor.elevation_m} m.n.p.m.) leżą:\n\n` +
    `${lines}\n\n` +
    'Które z nich chcesz zobaczyć bliżej?'
  );
}

export function formatRangePickReply(
  phrase: string,
  peaks: Array<{ name: string; elevationM: number }>,
  departure?: StatedDeparture,
): string {
  const lines = peaks.slice(0, MAX_NEARBY_RANGES).map((peak) => {
    const elevation =
      Number.isFinite(peak.elevationM) && peak.elevationM > 0
        ? ` (${Math.round(peak.elevationM)} m.n.p.m.)`
        : '';
    return `- **${peak.name}**${elevation}`;
  });
  return `${startStays(departure)}W paśmie, o które pytasz (${phrase}), z katalogu trailON:\n\n${lines.join('\n')}\n\nKtóry szczyt bierzemy na trasę?`;
}

export function formatPeakFocusReply(
  peak: { name: string; elevation_m: number; range_name: string; description?: string | null },
  departure?: StatedDeparture,
  alternatives?: Array<{ name: string; elevation_m: number; range_name: string }>,
): string {
  const start = startStays(departure);
  if (alternatives && alternatives.length > 1) {
    const lines = alternatives
      .slice(0, MAX_NEARBY_RANGES)
      .map(
        (item) =>
          `- **${item.name}** (${Math.round(item.elevation_m)} m.n.p.m.) — ${item.range_name}`,
      )
      .join('\n');
    return `${start}W katalogu jest więcej niż jeden szczyt pasujący do „${peak.name}”:\n\n${lines}\n\nKtóry masz na myśli?`;
  }
  const description = clipText(peak.description, 420);
  const about = description ? `\n\n${description}` : '';
  return `${start}${peak.name} (${Math.round(peak.elevation_m)} m.n.p.m.) leży w paśmie ${peak.range_name}.${about}`;
}

interface AnchorPeak {
  peak_id: string;
  name: string;
  elevation_m: number;
  range_name: string;
  lat: number;
  lng: number;
  description?: string | null;
}

export async function runRangesBeside(
  d1: D1Service,
  like: string,
  preferPrefix: string | undefined,
  departure?: StatedDeparture,
): Promise<GuideToolResult | undefined> {
  const stem = likeSafe(like);
  if (stem.length < 4) {
    return undefined;
  }
  try {
    const table = d1.assertTableName(d1.peaksTable);
    const rows = await d1.query<AnchorPeak>(
      `SELECT peak_id, name, elevation_m, range_name, lat, lng
       FROM ${table}
       WHERE status = 'published'
         AND lat IS NOT NULL
         AND lng IS NOT NULL
         AND range_name LIKE ?
       ORDER BY elevation_m DESC
       LIMIT 30`,
      [`%${stem}%`],
    );
    const anchor = pickAnchor(rows, preferPrefix);
    if (!anchor) {
      return undefined;
    }
    const nearest = await nearestRangePeaks(d1, anchor.lat, anchor.lng, MAX_NEARBY_RANGES + 1);
    const anchorRange = foldPolish(anchor.range_name);
    const neighbors = nearest
      .filter((range) => foldPolish(range.range_name) !== anchorRange)
      .slice(0, MAX_NEARBY_RANGES);
    if (neighbors.length === 0) {
      return undefined;
    }
    const reply = formatRangesBesideReply(anchor, neighbors, departure);
    const facts = neighbors
      .map((range, index) => {
        const km = formatKm(range.distance_km);
        return `${index + 1}. ${range.range_name} — ${km} km do ${range.name} (${range.elevation_m} m.n.p.m., id=${range.peak_id})`;
      })
      .join('\n');
    return focusResult(
      `Pytanie jest o okolice pasma ${anchor.range_name}, nie o listę najbliższych pasm od miejscowości.\n` +
        `Fakty liczone w linii prostej od szczytu ${anchor.name} (${anchor.elevation_m} m.n.p.m., id=${anchor.peak_id}) w tym paśmie:\n` +
        `${facts}\n\n` +
        'Napisz to po ludzku. Nie zaczynaj od „Liczę od”. Nie powtarzaj poprzedniej listy pasm od punktu startu. ' +
        startNote(departure),
      reply,
      neighbors,
    );
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
      throw error;
    }
    return undefined;
  }
}

export async function runPeakFocus(
  d1: D1Service,
  name: string,
  departure?: StatedDeparture,
): Promise<GuideToolResult | undefined> {
  const query = likeSafe(name);
  if (query.length < 3) {
    return undefined;
  }
  try {
    const table = d1.assertTableName(d1.peaksTable);
    const rows = await d1.query<AnchorPeak>(
      `SELECT peak_id, name, elevation_m, range_name, lat, lng, description
       FROM ${table}
       WHERE status = 'published' AND name LIKE ?
       ORDER BY recommended DESC, elevation_m DESC
       LIMIT 8`,
      [`%${query}%`],
    );
    const ranked = [...rows].sort(
      (left, right) => rankPeakName(left.name, query) - rankPeakName(right.name, query),
    );
    const best = ranked[0];
    if (!best || rankPeakName(best.name, query) > 1) {
      return undefined;
    }
    const same = ranked.filter((row) => rankPeakName(row.name, query) <= 1).slice(0, MAX_NEARBY_RANGES);
    const several = same.length > 1 && rankPeakName(best.name, query) > 0;
    const reply = formatPeakFocusReply(best, departure, several ? same : undefined);
    const facts = same
      .map(
        (row) =>
          `${row.name} (${row.elevation_m} m.n.p.m.) | pasmo: ${row.range_name} | id=${row.peak_id}` +
          (row.description?.trim() ? `\n${row.description.trim()}` : ''),
      )
      .join('\n\n');
    return focusResult(
      `Pytanie jest o ten szczyt, nie o nową miejscowość i nie o listę najbliższych pasm.\n${facts}\n\n` +
        'Opisz szczyt z tych faktów i z bloga, jeśli jest w materiałach. Nie zaczynaj od „Liczę od”. ' +
        startNote(departure),
      reply,
      same.map((row) => ({
        peak_id: row.peak_id,
        name: row.name,
        elevation_m: row.elevation_m,
        range_name: row.range_name,
        distance_km: 0,
      })),
    );
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
      throw error;
    }
    return undefined;
  }
}

function specificTargetRefusal(departure?: StatedDeparture): GuideToolResult {
  return {
    text:
      'To nie jest prośba o listę najbliższych pasm. Nie pisz „Liczę od…” i nie wklejaj poprzedniej listy. ' +
      'Odpowiedz na pytanie o konkretne pasmo, szczyt albo okolicę. ' +
      startNote(departure),
    sourceKeys: [],
  };
}

function startStays(departure?: StatedDeparture): string {
  if (!departure) {
    return '';
  }
  return `Start zostaje: ${departure.locality} (woj. ${departure.voivodeship}).\n\n`;
}

function startNote(departure?: StatedDeparture): string {
  if (!departure) {
    return 'Nie szukaj nowego punktu startu.';
  }
  return `Punkt startu zostaje: ${departure.locality} (woj. ${departure.voivodeship}). Jedno zdanie o dojeździe wolno dodać, gdy pomaga.`;
}

function focusResult(instruction: string, reply: string, ranges: RangePeakDistance[]): GuideToolResult {
  return {
    text: instruction,
    focusReply: reply,
    sourceKeys: ranges.map((range) => `peak:${range.peak_id}`),
    sources: ranges.map((range) => ({
      id: range.peak_id,
      title: range.name,
      source: RAG_SOURCE_LOCATIONS.szczyty,
    })),
    peaks: ranges.map((range) => ({
      id: range.peak_id,
      name: range.name,
      elevationM: range.elevation_m,
    })),
  };
}

function pickAnchor(rows: AnchorPeak[], preferPrefix: string | undefined): AnchorPeak | undefined {
  const located = rows.filter(
    (row) => row.range_name?.trim() && row.name?.trim() && Number.isFinite(row.lat) && Number.isFinite(row.lng),
  );
  if (located.length === 0) {
    return undefined;
  }
  const prefix = preferPrefix ? foldPolish(preferPrefix) : '';
  const preferred = prefix
    ? located.filter((row) => foldPolish(row.range_name).startsWith(prefix))
    : located;
  const pool = preferred.length > 0 ? preferred : located;
  return [...pool].sort((left, right) => Number(right.elevation_m) - Number(left.elevation_m))[0];
}

function rankPeakName(candidate: string, query: string): number {
  const left = foldPolish(candidate);
  const right = foldPolish(query);
  if (!left || !right) {
    return 3;
  }
  if (left === right) {
    return 0;
  }
  if (left.startsWith(right) || right.startsWith(left)) {
    return 1;
  }
  return 2;
}

function likeSafe(value: string): string {
  return value.replace(/[%_]/g, '').trim();
}

function clipText(value: string | null | undefined, max: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function copyResult(copy: GuideCopy, ranges: RangePeakDistance[]): GuideToolResult {
  return {
    text: `${copy.instruction}\n\nOdpowiedź dla użytkownika:\n${copy.reply}`,
    directReply: copy.reply,
    sourceKeys: ranges.map((range) => `peak:${range.peak_id}`),
    sources: ranges.map((range) => ({
      id: range.peak_id,
      title: range.name,
      source: RAG_SOURCE_LOCATIONS.szczyty,
    })),
    peaks: ranges.map((range) => ({
      id: range.peak_id,
      name: range.name,
      elevationM: range.elevation_m,
    })),
  };
}

function catalogFailure(): GuideToolResult {
  return copyResult(
    {
      instruction: 'Katalog szczytów jest niedostępny. Nie zgaduj pasm ani odległości.',
      reply: 'Nie udało mi się teraz odczytać katalogu szczytów, więc nie podam odległości do pasm. Spróbuj za chwilę.',
    },
    [],
  );
}

function readyPlace(
  hit: GeocodeHit,
  locality: string,
  voivodeship: string,
  several: boolean,
): Extract<DeparturePlace, { kind: 'ready' }> {
  const county = hit.admin2?.replace(/\)$/, '').trim();
  const assumption = several
    ? `W woj. ${voivodeship} jest więcej niż jedna miejscowość „${locality}”. Przyjmuję ${county ? `${locality} (${county})` : locality}.`
    : undefined;
  return {
    kind: 'ready',
    lat: hit.latitude,
    lng: hit.longitude,
    locality,
    voivodeship,
    assumption,
  };
}

function uniqueVoivodeships(hits: GeocodeHit[]): string[] {
  const names: string[] = [];
  for (const hit of hits) {
    const name = canonicalVoivodeship(hit.admin1 ?? '');
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function pickMostPopulous(hits: GeocodeHit[]): GeocodeHit {
  return [...hits].sort((left, right) => (right.population ?? 0) - (left.population ?? 0))[0]!;
}

function displayName(hits: GeocodeHit[], fallback: string): string {
  return hits[0]?.name?.trim() || fallback;
}

function readGeocodeHit(value: unknown): GeocodeHit | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const name = readString(row.name);
  const latitude = readFloat(row.latitude);
  const longitude = readFloat(row.longitude);
  if (!name || latitude === undefined || longitude === undefined) {
    return undefined;
  }
  const population = readFloat(row.population);
  return {
    name,
    latitude,
    longitude,
    country_code: readString(row.country_code),
    admin1: readString(row.admin1),
    admin2: readString(row.admin2),
    population,
  };
}

function sameLocality(hitName: string, query: string): boolean {
  const left = normalizePlaceLabel(hitName);
  const right = normalizePlaceLabel(cleanLocality(query));
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const extra = right.slice(left.length);
  return right.startsWith(left) && extra.length > 0 && extra.length <= 3 && !extra.includes(' ');
}

function cleanLocality(value: string): string {
  return value
    .replace(/^(?:z|ze|od)\s+/i, '')
    .replace(/,.*$/, '')
    .trim();
}

function formatKm(distance: number): string {
  return distance.toFixed(1).replace('.', ',');
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_NEARBY_RANGES;
  }
  return Math.max(1, Math.min(MAX_NEARBY_RANGES, Math.trunc(value)));
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

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
