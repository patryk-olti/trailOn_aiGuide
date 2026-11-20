export interface CatalogPrefetchPlan {
  peaks?: {
    range?: string;
    query?: string;
    limit: number;
  };
  materials: {
    query: string;
    limit: number;
  };
}

const RANGE_BY_KEYWORD: Array<{ pattern: RegExp; range: string }> = [
  { pattern: /karkonosz/i, range: 'Karkonosze' },
  { pattern: /\bbieszczad/i, range: 'Bieszczady' },
  { pattern: /\btatr/i, range: 'Tatry' },
  { pattern: /\bbeskid/i, range: 'Beskid' },
  { pattern: /\bgór\s*świetokrzysk/i, range: 'Góry Świętokrzyskie' },
  { pattern: /\bpienin/i, range: 'Pieniny' },
];

export function extractMountainRange(message: string): string | undefined {
  for (const entry of RANGE_BY_KEYWORD) {
    if (entry.pattern.test(message)) {
      return entry.range;
    }
  }
  return undefined;
}

export interface LooseRange {
  /** Fragment z wiadomości, np. „gór kaczawskich”. */
  phrase: string;
  /** Rdzeń do LIKE w katalogu, np. „kaczawsk”. */
  like: string;
  /** „Góry”, „Pogórze” albo „Wzgórza”, gdy da się to wyczytać z wiadomości. */
  preferPrefix?: 'Góry' | 'Pogórze' | 'Wzgórza';
}

const RANGE_HEAD =
  /(?:^|[^\p{L}])(gór(?:y|ach|om|ami|ę)?|pogórz(?:e|a|u|em)?|wzgórz(?:a|ach|om|ami|e)?)\s+([\p{L}][\p{L}'’-]+)/iu;

const RANGE_NAME_STOP = new Set([
  'w',
  'na',
  'do',
  'od',
  'ze',
  'czy',
  'jak',
  'dla',
  'pod',
  'nad',
  'przy',
  'oraz',
  'albo',
  'cos',
  'sie',
  'nie',
  'tak',
  'tym',
  'tej',
  'tego',
  'ten',
  'tam',
  'tylko',
  'jeszcze',
  'bardzo',
  'prosze',
  'co',
  'to',
  'te',
  'ta',
]);

const RANGE_ENDINGS = ['iego', 'emu', 'ymi', 'imi', 'ych', 'ich', 'ego', 'ie', 'ia', 'ej', 'a', 'e', 'y', 'i', 'u'];

/**
 * Pasmo nazwane wprost, także poza krótką listą słów kluczowych.
 * „góry kaczawskie”, „gór kaczawskich”, „pogórze kaczawskie”.
 */
export function extractLooseRange(message: string): LooseRange | undefined {
  const match = RANGE_HEAD.exec(message);
  const head = match?.[1];
  const name = match?.[2];
  if (!head || !name) {
    return undefined;
  }
  const foldedName = normalizePolish(name);
  if (foldedName.length < 4 || RANGE_NAME_STOP.has(foldedName)) {
    return undefined;
  }
  const like = rangeStem(foldedName);
  if (like.length < 4) {
    return undefined;
  }
  const foldedHead = normalizePolish(head);
  const preferPrefix = foldedHead.startsWith('pogorz')
    ? 'Pogórze'
    : foldedHead.startsWith('wzgorz')
      ? 'Wzgórza'
      : 'Góry';
  return {
    phrase: `${head} ${name}`,
    like,
    preferPrefix,
  };
}

/** „co jest przy Grodziec”, nie „obok gór kaczawskich” — to drugie jest pasmem. */
export function placeAskedAbout(message: string): string | undefined {
  const match =
    /(?:^|[^\p{L}])(?:co\s+jest\s+)?(?:przy|obok|koło|kolo)\s+([\p{L}][\p{L}'’-]+(?:\s+[\p{L}][\p{L}'’-]+){0,2})/iu.exec(
      message,
    );
  const phrase = match?.[1]?.trim();
  if (!phrase) {
    return undefined;
  }
  const head = normalizePolish(phrase.split(/\s+/)[0] ?? '');
  if (/^(gor|pogorz|wzgorz)/.test(head) || RANGE_NAME_STOP.has(head)) {
    return undefined;
  }
  return phrase;
}

export function messageAsksWhatIsBeside(message: string): boolean {
  return /(?:^|[^\p{L}])(obok|koło|kolo|sąsiad\p{L}*|sasied\p{L}*|granicz\p{L}*|okolic\p{L}*|pobliżu|poblizu)/iu.test(
    message,
  );
}

export function messageConcernsPeaks(message: string): boolean {
  if (extractMountainRange(message) || extractLooseRange(message) || placeAskedAbout(message)) {
    return true;
  }
  return /(szczyt|szczyty|najwyższ|pasmo\s+gór|góry\b|górsk)/i.test(message);
}

function rangeStem(foldedName: string): string {
  for (const ending of RANGE_ENDINGS) {
    if (!foldedName.endsWith(ending)) {
      continue;
    }
    const stem = foldedName.slice(0, -ending.length);
    const longEnough = ending.length === 1 ? stem.length >= 5 : stem.length >= 4;
    if (longEnough) {
      return stem;
    }
  }
  return foldedName;
}

function normalizePolish(input: string): string {
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Próbuje odczytać liczbę szczytów z pytania użytkownika:
 * - "wymień 5 szczytów", "podaj 10 najwyższych szczytów", "top 7 szczytów"
 * Zwraca undefined jeśli użytkownik nie prosi o konkretną liczbę.
 */
export function extractRequestedPeakCount(message: string): number | undefined {
  const normalized = normalizePolish(message);

  // Najpierw cyfry: "5 szczytów", "top 10 szczytów", "10 najwyższych szczytów"
  const numeric =
    /(?:top\s*)?(\d{1,2})\s+(?:najwyzszych\s+)?(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(
      normalized,
    ) ??
    /wymien\s+(\d{1,2})\s+(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(normalized) ??
    /podaj\s+(\d{1,2})\s+(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(normalized);
  if (numeric?.[1]) {
    const parsed = Number(numeric[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Potem słowne 1..20 (bez odmian wszystkich przypadków — wystarcza do typowych pytań).
  const WORDS: Record<string, number> = {
    jeden: 1,
    jedna: 1,
    jedno: 1,
    dwa: 2,
    dwie: 2,
    trzy: 3,
    cztery: 4,
    piec: 5,
    szesc: 6,
    siedem: 7,
    osiem: 8,
    dziewiec: 9,
    dziesiec: 10,
    jedenascie: 11,
    dwanascie: 12,
    trzynascie: 13,
    czternascie: 14,
    pietnascie: 15,
    szesnascie: 16,
    siedemnascie: 17,
    osiemnascie: 18,
    dziewietnascie: 19,
    dwadziescia: 20,
  };

  const wordMatch =
    /(?:top\s*)?([a-z]{3,12})\s+(?:najwyzszych\s+)?(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(
      normalized,
    ) ??
    /wymien\s+([a-z]{3,12})\s+(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(normalized) ??
    /podaj\s+([a-z]{3,12})\s+(?:szczyt(?:y|ow)?|wierzchol(?:ek|ki|kow)?)/i.exec(normalized);

  if (wordMatch?.[1]) {
    const word = wordMatch[1];
    const value = WORDS[word];
    if (typeof value === 'number' && value > 0) {
      return value;
    }
  }

  return undefined;
}

export function planCatalogPrefetch(message: string): CatalogPrefetchPlan | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!messageConcernsPeaks(trimmed)) {
    return undefined;
  }

  const knownRange = extractMountainRange(trimmed);
  const looseRange = knownRange ? undefined : extractLooseRange(trimmed);
  const range =
    knownRange ??
    (looseRange ? `${looseRange.preferPrefix ?? ''} ${looseRange.like}`.trim() : undefined);
  const materialsQuery = knownRange
    ? `szczyty ${knownRange} blog`
    : looseRange
      ? `szczyty ${looseRange.phrase} blog`
      : trimmed;
  const requested = extractRequestedPeakCount(trimmed);
  const peaksLimit = clampInt(requested ?? 3, 1, 20);

  return {
    peaks: {
      range,
      limit: peaksLimit,
    },
    materials: {
      query: materialsQuery,
      limit: 6,
    },
  };
}