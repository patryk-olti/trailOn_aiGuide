import { normalizePeakName } from '../rag/rag-blog-lookup';

export interface LibraryRoute {
  id: string;
  name: string;
  range?: string;
  difficulty?: string;
  lengthKm?: number;
  elevationM?: number;
  url?: string;
  hasGpx: boolean;
  checkpoints: string[];
}

const ROUTE_INTENT =
  /(tras[aąęy]|szlak|dojś|dojsc|wycieczk|jak\s+(?:doj|wej|iść|isc)|wejść|wejsc)/i;

const QUERY_STOPWORDS = new Set([
  'trasa',
  'trasy',
  'trase',
  'tras',
  'szlak',
  'szlaku',
  'szlaki',
  'szlakiem',
  'wycieczka',
  'wycieczke',
  'wycieczki',
  'dojscie',
  'dojscia',
  'wejscie',
  'wejscia',
  'biblioteka',
  'biblioteki',
  'prosze',
  'poprosze',
  'jaka',
  'jaki',
  'jakie',
  'chce',
  'chcialbym',
  'polec',
  'polecasz',
  'propozycja',
  'propozycje',
  'szczyt',
  'szczytu',
  'szczycie',
  'gory',
  'gorach',
  'dla',
  'oraz',
  'albo',
]);

export function messageAsksForRoute(message: string): boolean {
  return ROUTE_INTENT.test(message);
}

export function routeQueryTokens(query: string): string[] {
  const normalized = normalizePeakName(query);
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  return tokens.filter((token) => !QUERY_STOPWORDS.has(token));
}

export function parseLibraryPlan(key: string, rawJson: string): LibraryRoute | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const name = readString(record.nazwa);
  if (!name) {
    return undefined;
  }
  const planId =
    readString(record.identyfikator) ??
    key.split('/').filter(Boolean).pop()?.replace(/\.json$/i, '');
  return {
    id: key,
    name,
    range: readString(record.pasmo),
    difficulty: readString(record.trudnosc),
    lengthKm: readNumber(record.dlugosc_km),
    elevationM: readNumber(record.przewyzszenie_m),
    url: libraryUrl(record, planId),
    hasGpx: isGpxPayload(record.gpx),
    checkpoints: checkpointNames(record),
  };
}

export function rankLibraryRoutes(routes: LibraryRoute[], query: string, limit: number): LibraryRoute[] {
  const tokens = routeQueryTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  return routes
    .map((route) => ({ route, score: scoreRoute(route, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.route.name.localeCompare(right.route.name, 'pl'))
    .slice(0, limit)
    .map((entry) => entry.route);
}

export function formatLibraryRouteProposals(routes: LibraryRoute[]): string {
  if (routes.length === 0) {
    return 'W bibliotece tras nie ma planu pasującego do zapytania. Nie wymyślaj trasy.';
  }
  const lines = routes.map((route, index) => {
    const bits = [
      route.range,
      route.difficulty,
      route.lengthKm !== undefined && route.lengthKm > 0 ? `${route.lengthKm} km` : undefined,
      route.elevationM !== undefined && route.elevationM > 0
        ? `przewyższenie ${route.elevationM} m`
        : undefined,
      route.hasGpx ? 'ślad GPX: tak' : undefined,
      route.url ? `url (kopiuj dosłownie): ${route.url}` : undefined,
    ].filter((part): part is string => Boolean(part));
    const points = route.checkpoints.slice(0, 6).join(', ');
    const header = `${index + 1}. ${route.name}${bits.length > 0 ? ` | ${bits.join(' | ')}` : ''}`;
    return points ? `${header}\nPunkty: ${points}` : header;
  });
  return `Propozycje z biblioteki tras (podaj je użytkownikowi, link url kopiuj dosłownie):\n${lines.join('\n\n')}`;
}

function scoreRoute(route: LibraryRoute, tokens: string[]): number {
  const name = normalizePeakName(route.name);
  const range = normalizePeakName(route.range ?? '');
  const checkpoints = route.checkpoints.map((checkpoint) => normalizePeakName(checkpoint));
  let score = 0;
  if (tokens.every((token) => includesStem(name, token))) {
    score += 8;
  }
  for (const token of tokens) {
    if (includesStem(name, token)) {
      score += 4;
    } else if (checkpoints.some((checkpoint) => includesStem(checkpoint, token))) {
      score += 3;
    } else if (includesStem(range, token)) {
      score += 2;
    }
  }
  return score;
}

function includesStem(haystack: string, token: string): boolean {
  if (!haystack || !token) {
    return false;
  }
  if (haystack.includes(token)) {
    return true;
  }
  if (token.length >= 5 && haystack.includes(token.slice(0, 5))) {
    return true;
  }
  if (token.length >= 4 && haystack.includes(token.slice(0, -1))) {
    return true;
  }
  return false;
}

function libraryUrl(record: Record<string, unknown>, planId: string | undefined): string | undefined {
  const explicit = readString(record.url);
  if (explicit?.startsWith('https://trailon.pl/')) {
    return explicit;
  }
  if (!planId) {
    return undefined;
  }
  return `https://trailon.pl/plan/library?planId=${encodeURIComponent(planId)}`;
}

function isGpxPayload(value: unknown): boolean {
  return typeof value === 'string' && value.includes('<gpx');
}

function checkpointNames(record: Record<string, unknown>): string[] {
  const names: string[] = [];
  collectNames(record.punkty_kontrolne, names);
  collectNames(record.odcinki_trasy, names);
  return names;
}

function collectNames(value: unknown, names: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const name = readString((item as Record<string, unknown>).nazwa);
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}
