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

export function messageConcernsPeaks(message: string): boolean {
  return /(szczyt|szczyty|najwyższ|pasmo\s+gór|góry\b|górsk)/i.test(message);
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

  const range = extractMountainRange(trimmed);
  const materialsQuery = range ? `szczyty ${range} blog` : trimmed;
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