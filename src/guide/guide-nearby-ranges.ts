import https from 'node:https';
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
const PHOTON_URL = 'https://photon.komoot.io/api/';
const GEOCODE_TIMEOUT_MS = 5_000;
const GEOCODE_USER_AGENT = 'trailon-aiguide/0.1 (departure geocoder)';

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

const VOIVODESHIP_INFLECTION = /^(?:go|mu|m|j|ego|emu|ym|im|ej)$/;

function tokenMatchesVoivodeshipKey(token: string, key: string): boolean {
  if (token === key) {
    return true;
  }
  if (!token.startsWith(key)) {
    return false;
  }
  const extra = token.slice(key.length);
  return extra.length > 0 && extra.length <= 3 && VOIVODESHIP_INFLECTION.test(extra);
}

function phraseMatchesVoivodeshipKey(tokens: string[], key: string): boolean {
  const parts = key.split(' ');
  if (parts.length === 1) {
    return tokens.some((token) => tokenMatchesVoivodeshipKey(token, parts[0]!));
  }
  for (let index = 0; index <= tokens.length - parts.length; index += 1) {
    const headMatches = parts.slice(0, -1).every((part, offset) => tokens[index + offset] === part);
    const last = tokens[index + parts.length - 1];
    const stem = parts[parts.length - 1];
    if (headMatches && last && stem && tokenMatchesVoivodeshipKey(last, stem)) {
      return true;
    }
  }
  return false;
}

export function canonicalVoivodeship(input: string): string | undefined {
  const key = normalizePlaceLabel(input);
  if (!key) {
    return undefined;
  }
  return VOIVODESHIP_KEYS.find((entry) => entry.key === key)?.name ?? mentionedVoivodeship(key);
}

export function mentionedVoivodeship(message: string): string | undefined {
  const normalized = normalizePlaceLabel(message);
  if (!normalized) {
    return undefined;
  }
  const haystack = ` ${normalized} `;
  const exact = VOIVODESHIP_KEYS.find((entry) => haystack.includes(` ${entry.key} `));
  if (exact) {
    return exact.name;
  }
  const tokens = normalized.split(' ').filter(Boolean);
  return VOIVODESHIP_KEYS.find((entry) => phraseMatchesVoivodeshipKey(tokens, entry.key))?.name;
}

export function messageGivesDeparturePlace(message: string): boolean {
  if (!mentionedVoivodeship(message)) {
    return false;
  }
  return localityBesideVoivodeship(message) !== undefined;
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
  const fromPattern = /\b(?:z|ze|od)\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/giu;
  for (const match of message.matchAll(fromPattern)) {
    const fromPlace = cleanPlaceToken(match[1]);
    if (fromPlace) {
      return fromPlace;
    }
  }
  const woj = message.match(
    /(?:^|[^\p{L}])([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})\s+woj(?:ewództwo)?(?:\.|\b)/iu,
  );
  const wojPlace = cleanPlaceToken(woj?.[1]);
  if (wojPlace) {
    return wojPlace;
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
  const asked = voivodeship ? canonicalVoivodeship(voivodeship) : undefined;
  if (voivodeship?.trim() && !asked) {
    return { kind: 'unknown_voivodeship', given: voivodeship.trim() };
  }
  const placeName = cleanLocality(locality);
  if (!placeName || canonicalVoivodeship(placeName)) {
    return {
      kind: 'not_found',
      locality: placeName || locality.trim(),
      voivodeship: asked,
      elsewhere: [],
    };
  }
  const exact = hits.filter(
    (hit) =>
      hit.country_code === 'PL' &&
      isValidLatLng(hit.latitude, hit.longitude) &&
      sameLocality(hit.name, placeName),
  );

  if (exact.length === 0) {
    return { kind: 'not_found', locality: placeName, voivodeship: asked, elsewhere: [] };
  }

  if (!asked) {
    const voivodeships = uniqueVoivodeships(exact);
    if (voivodeships.length === 1) {
      const only = voivodeships[0]!;
      const inVoivodeship = exact.filter((hit) => canonicalVoivodeship(hit.admin1 ?? '') === only);
      const chosen = pickMostPopulous(inVoivodeship);
      return readyPlace(chosen, chosen.name, only, inVoivodeship.length > 1);
    }
    const dominant = dominantAmongVoivodeships(exact);
    if (dominant) {
      const inVoivodeship = exact.filter(
        (hit) => canonicalVoivodeship(hit.admin1 ?? '') === dominant.voivodeship,
      );
      return readyPlace(
        dominant.hit,
        dominant.hit.name,
        dominant.voivodeship,
        inVoivodeship.length > 1,
        `Przyjmuję ${dominant.hit.name} w woj. ${dominant.voivodeship} — to największa miejscowość o tej nazwie.`,
      );
    }
    return { kind: 'need_voivodeship', locality: displayName(exact, placeName), voivodeships };
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
      'Jeśli nie chcesz podawać GPS, napisz, skąd jedziesz: miejscowość i województwo albo samą miejscowość. O województwo dopytam tylko wtedy, gdy ta nazwa leży w kilku.',
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
  const stated = userMessage ? statedDepartureFromText(userMessage) : undefined;
  if (stated) {
    locality = stated.locality;
    voivodeship = stated.voivodeship;
  } else if (locality) {
    const cleaned = cleanLocality(locality);
    if (cleaned && !canonicalVoivodeship(cleaned)) {
      locality = cleaned;
    }
    if (voivodeship) {
      const canonical = canonicalVoivodeship(voivodeship);
      if (canonical) {
        voivodeship = canonical;
      }
    }
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
  const queries = localityQueries(locality);
  const primary = await collectHits(queries, fetchOpenMeteoHits, signal);
  if (hitsInPoland(primary.hits).length > 0) {
    return primary.hits;
  }
  if (primary.failure) {
    const reason = primary.failure instanceof Error ? primary.failure.message : String(primary.failure);
    console.error(`Geokoder Open-Meteo niedostępny (${reason}). Szukam miejscowości w Photon.`);
  }
  const secondary = await collectHits(queries, fetchPhotonHits, signal);
  if (secondary.hits.length > 0) {
    return secondary.hits;
  }
  const failure = primary.failure ?? secondary.failure;
  if (failure) {
    throw failure;
  }
  return [];
}

export async function runSearchLocality(args: ToolArgs, signal?: AbortSignal): Promise<GuideToolResult> {
  const raw = readString(args.query);
  if (!raw) {
    return { text: 'Podaj nazwę miejscowości.', sourceKeys: [] };
  }
  const stated = statedDepartureFromText(raw);
  const explicitVoivodeship = readString(args.voivodeship);
  const locality = stated?.locality ?? cleanLocality(raw);
  const voivodeship =
    stated?.voivodeship ??
    (explicitVoivodeship
      ? canonicalVoivodeship(explicitVoivodeship) ?? explicitVoivodeship
      : mentionedVoivodeship(raw));
  if (!locality || canonicalVoivodeship(locality)) {
    return {
      text: 'W tej wypowiedzi nie ma nazwy miejscowości. Poproś o miejscowość i województwo. Nie zgaduj współrzędnych.',
      sourceKeys: [],
    };
  }
  try {
    const hits = await geocodeLocality(locality, signal);
    return formatLocalitySearch(resolveDeparturePlace(hits, locality, voivodeship));
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name)) {
      throw error;
    }
    return copyResult(
      {
        instruction:
          'Geokoder miejscowości niedostępny. Poproś, aby powtórzył miejscowość i województwo. Nie zgaduj współrzędnych ani pasm.',
        reply:
          'Nie udało mi się ustalić tej miejscowości na mapie. Napisz jeszcze raz, skąd jedziesz: miejscowość i województwo.',
      },
      [],
    );
  }
}

function formatLocalitySearch(place: DeparturePlace): GuideToolResult {
  if (place.kind === 'ready') {
    const county = place.assumption ? ` ${place.assumption}` : '';
    return {
      text:
        `Miejscowość ustalona: ${place.locality} (woj. ${place.voivodeship}), współrzędne ${place.lat}, ${place.lng}.${county} ` +
        `Wywołaj suggest_nearby_ranges z locality „${place.locality}” i voivodeship „${place.voivodeship}”. ` +
        'Nie pytaj ponownie o miejscowość i nie podstawiaj innego miasta.',
      sourceKeys: [],
    };
  }
  if (place.kind === 'need_voivodeship') {
    return copyResult(formatNeedVoivodeship(place.locality, place.voivodeships), []);
  }
  if (place.kind === 'unknown_voivodeship') {
    return copyResult(formatUnknownVoivodeship(place.given), []);
  }
  return copyResult(formatPlaceNotFound(place), []);
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
  if (words.length === 1 && /owa$/iu.test(primary) && primary.length > 5) {
    push(`${primary.slice(0, -3)}ów`);
  }
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

async function collectHits(
  queries: string[],
  fetchHits: (name: string, signal?: AbortSignal) => Promise<GeocodeHit[]>,
  signal?: AbortSignal,
): Promise<{ hits: GeocodeHit[]; failure?: unknown }> {
  const collected: GeocodeHit[] = [];
  const seen = new Set<string>();
  let failure: unknown;
  for (const query of queries) {
    try {
      const hits = await fetchHits(query, signal);
      for (const hit of hits) {
        const key = `${hit.country_code ?? ''}|${normalizePlaceLabel(hit.name)}|${hit.latitude.toFixed(4)}|${hit.longitude.toFixed(4)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        collected.push(hit);
      }
    } catch (error) {
      if (isClientAbort(error)) {
        throw error;
      }
      failure = error;
    }
  }
  return failure ? { hits: collected, failure } : { hits: collected };
}

function hitsInPoland(hits: GeocodeHit[]): GeocodeHit[] {
  return hits.filter((hit) => hit.country_code === 'PL');
}

async function fetchOpenMeteoHits(name: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const query = new URLSearchParams({
    name,
    count: '20',
    language: 'pl',
    format: 'json',
  });
  const payload = (await requestJson(new URL(`${GEOCODE_URL}?${query}`), signal)) as { results?: unknown };
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return [];
  }
  return payload.results.flatMap((row) => {
    const hit = readGeocodeHit(row);
    return hit ? [hit] : [];
  });
}

const PHOTON_PLACE_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'locality',
  'suburb',
  'municipality',
  'isolated_dwelling',
]);

async function fetchPhotonHits(name: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const query = new URLSearchParams({
    q: name,
    limit: '15',
  });
  const payload = await requestJson(new URL(`${PHOTON_URL}?${query}`), signal);
  return hitsFromPhotonPayload(payload);
}

/** Photon nie podaje liczby mieszkańców. Pierwsze miasto o tej nazwie jest tym ważniejszym. */
export function hitsFromPhotonPayload(payload: unknown): GeocodeHit[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { features?: unknown }).features)) {
    return [];
  }
  const features = (payload as { features: unknown[] }).features;
  const rankByName = new Map<string, number>();
  const hits: GeocodeHit[] = [];
  for (const feature of features) {
    const hit = readPhotonFeature(feature, rankByName);
    if (hit) {
      hits.push(hit);
    }
  }
  return hits;
}

function readPhotonFeature(value: unknown, rankByName: Map<string, number>): GeocodeHit | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const feature = value as {
    geometry?: { coordinates?: unknown };
    properties?: Record<string, unknown>;
  };
  const props = feature.properties;
  const coordinates = feature.geometry?.coordinates;
  if (!props || !Array.isArray(coordinates) || coordinates.length < 2) {
    return undefined;
  }
  const placeType = readString(props.osm_value) ?? readString(props.type);
  if (!placeType || !PHOTON_PLACE_TYPES.has(placeType)) {
    return undefined;
  }
  const country = (readString(props.countrycode) ?? '').toUpperCase();
  if (country && country !== 'PL') {
    return undefined;
  }
  const name = readString(props.name);
  const longitude = readFloat(coordinates[0]);
  const latitude = readFloat(coordinates[1]);
  if (!name || latitude === undefined || longitude === undefined) {
    return undefined;
  }
  const key = normalizePlaceLabel(name);
  const rank = rankByName.get(key) ?? 0;
  rankByName.set(key, rank + 1);
  const population = rank === 0 && (placeType === 'city' || placeType === 'town') ? 50_000 : 200;
  return {
    name,
    latitude,
    longitude,
    country_code: country || 'PL',
    admin1: readString(props.state),
    admin2: readString(props.county),
    population,
  };
}

function requestJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        family: 4,
        servername: url.hostname,
        headers: {
          Accept: 'application/json',
          'User-Agent': GEOCODE_USER_AGENT,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            finish(new Error(`Geokoder odpowiedział ${status}`));
            return;
          }
          try {
            finish(undefined, JSON.parse(body) as unknown);
          } catch (error) {
            finish(error instanceof Error ? error : new Error('Geokoder zwrócił nie-JSON'));
          }
        });
      },
    );
    const onAbort = (): void => {
      req.destroy(abortError());
    };
    const finish = (error?: unknown, payload?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve(payload);
    };
    timer = setTimeout(() => {
      req.destroy(new Error('Geokoder nie odpowiedział w czasie'));
    }, GEOCODE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => {
      finish(error);
    });
    req.end();
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isClientAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

/** Miasto, nie wieś o tej samej nazwie w innym województwie. Jordanów (ok. 5 tys.) nadal wymaga doprecyzowania. */
const DOMINANT_CITY_POPULATION = 10_000;
const DOMINANT_CITY_RATIO = 20;

function dominantAmongVoivodeships(
  hits: GeocodeHit[],
): { hit: GeocodeHit; voivodeship: string } | undefined {
  const byRegion = new Map<string, GeocodeHit>();
  for (const hit of hits) {
    const region = canonicalVoivodeship(hit.admin1 ?? '');
    if (!region) {
      continue;
    }
    const current = byRegion.get(region);
    if (!current || (hit.population ?? 0) > (current.population ?? 0)) {
      byRegion.set(region, hit);
    }
  }
  const ranked = [...byRegion.entries()].sort(
    (left, right) => (right[1].population ?? 0) - (left[1].population ?? 0),
  );
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  const population = best[1].population ?? 0;
  const nextPopulation = ranked[1]?.[1].population ?? 0;
  if (population < DOMINANT_CITY_POPULATION) {
    return undefined;
  }
  if (nextPopulation * DOMINANT_CITY_RATIO > population) {
    return undefined;
  }
  return { hit: best[1], voivodeship: best[0] };
}

export function answerDiscardsDepartureFacts(answer: string, fallback: string): boolean {
  const deniesPlace = /nie udało mi się ustalić|nie znajduję miejscowości|nie udało[^.!\n]*na mapie/i.test(
    answer,
  );
  if (!deniesPlace) {
    return false;
  }
  return !/nie udało mi się ustalić|nie znajduję miejscowości/i.test(fallback);
}

function readyPlace(
  hit: GeocodeHit,
  locality: string,
  voivodeship: string,
  several: boolean,
  assumptionOverride?: string,
): Extract<DeparturePlace, { kind: 'ready' }> {
  const county = hit.admin2?.replace(/\)$/, '').trim();
  const assumption =
    assumptionOverride ??
    (several
      ? `W woj. ${voivodeship} jest więcej niż jedna miejscowość „${locality}”. Przyjmuję ${county ? `${locality} (${county})` : locality}.`
      : undefined);
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
  const text = value
    .replace(
      /^(?:(?:jad[eę]|wyjeżdżam|wyjezdzam|start(?:uję|uje)?|licz(?:ę|e)?|ruszam)\s+)?(?:z|ze|od)\s+/i,
      '',
    )
    .replace(/,.*$/, '')
    .replace(/\bwoj(?:ewództwo)?(?:\.|\b).*$/i, '')
    .trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1] ?? '';
    if (mentionedVoivodeship(last) || /^(?:z|ze|od)$/i.test(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(' ').trim();
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
