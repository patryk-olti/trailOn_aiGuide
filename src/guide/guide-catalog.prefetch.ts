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

  return {
    peaks: {
      range,
      limit: 8,
    },
    materials: {
      query: materialsQuery,
      limit: 6,
    },
  };
}