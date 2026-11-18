import { RagContentSource } from './rag.constants';
import { RagChunkDraft } from './rag.types';
import { expandChunkDrafts } from './rag-chunker';

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function checkpointLines(items: unknown, label: string): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const lines: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const name = readString(row.nazwa);
    if (!name) {
      continue;
    }
    const km = readNumber(row.km_od_startu);
    const elev = readNumber(row.wysokosc_m);
    const desc = readString(row.opis);
    const parts = [name];
    if (typeof km === 'number') {
      parts.push(`${km} km`);
    }
    if (typeof elev === 'number') {
      parts.push(`${elev} m n.p.m.`);
    }
    if (desc) {
      parts.push(desc);
    }
    lines.push(`${label}: ${parts.join(' — ')}`);
  }
  return lines;
}

function parseBlogJson(key: string, payload: Record<string, unknown>): RagChunkDraft[] {
  const peakName = readString(payload.nazwa_szczytu);
  const title = readString(payload.tytul) ?? peakName ?? key;
  const url = readString(payload.url);
  const kontent = readString(payload.kontent) ?? '';
  const intro = [
    peakName ? `Szczyt: ${peakName}` : undefined,
    readString(payload.zajawka),
    readString(payload.seo_opis),
    readString(payload.pasmo) ? `Pasmo: ${readString(payload.pasmo)}` : undefined,
    url ? `URL bloga: ${url}` : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  const text = [intro, kontent].filter((part) => part.length > 0).join('\n\n');
  return expandChunkDrafts({
    source: 'blog',
    key,
    title,
    url,
    peakName,
    text,
  });
}

function parsePlanJson(key: string, payload: Record<string, unknown>): RagChunkDraft[] {
  const title = readString(payload.nazwa) ?? key;
  const url = readString(payload.url);
  const summary = [
    readString(payload.pasmo) ? `Pasmo: ${readString(payload.pasmo)}` : undefined,
    readString(payload.trudnosc) ? `Trudność: ${readString(payload.trudnosc)}` : undefined,
    readNumber(payload.dlugosc_km) !== undefined ? `Długość: ${payload.dlugosc_km} km` : undefined,
    readNumber(payload.przewyzszenie_m) !== undefined
      ? `Przewyższenie: ${payload.przewyzszenie_m} m`
      : undefined,
    readString(payload.autor) ? `Autor: ${readString(payload.autor)}` : undefined,
    readNumber(payload.ocena_srednia) !== undefined
      ? `Ocena: ${payload.ocena_srednia} (${readNumber(payload.liczba_ocen) ?? 0})`
      : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  const checkpoints = checkpointLines(payload.punkty_kontrolne, 'Punkt kontrolny');
  const text = [summary, checkpoints.join('\n')].filter((part) => part.length > 0).join('\n\n');
  return expandChunkDrafts({
    source: 'biblioteka-tras',
    key,
    title,
    url,
    text,
  });
}

function parseLongDistanceJson(key: string, payload: Record<string, unknown>): RagChunkDraft[] {
  const title = readString(payload.nazwa) ?? key;
  const url = readString(payload.url);
  const summary = [
    readString(payload.opis),
    readNumber(payload.dlugosc_km) !== undefined ? `Długość szlaku: ${payload.dlugosc_km} km` : undefined,
    readNumber(payload.liczba_punktow_kontrolnych) !== undefined
      ? `Punkty kontrolne: ${payload.liczba_punktow_kontrolnych}`
      : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  const checkpoints = checkpointLines(payload.punkty_kontrolne, 'Punkt na szlaku');
  const text = [summary, checkpoints.join('\n')].filter((part) => part.length > 0).join('\n\n');
  return expandChunkDrafts({
    source: 'szlaki-dlugodystansowe',
    key,
    title,
    url,
    text,
  });
}

function parsePeakJson(key: string, payload: Record<string, unknown>): RagChunkDraft[] {
  const name = readString(payload.nazwa) ?? readString(payload.name);
  const range = readString(payload.pasmo) ?? readString(payload.range_name);
  const elevation =
    readNumber(payload.wysokosc_m) ??
    readNumber(payload.elevation_m) ??
    readNumber(payload.elevation);
  const url = readString(payload.url) ?? readString(payload.blog_url) ?? readString(payload.blogUrl);
  const description = readString(payload.opis) ?? readString(payload.description) ?? '';

  const title = name ?? key;
  const summary = [
    name ? `Szczyt: ${name}` : undefined,
    range ? `Pasmo: ${range}` : undefined,
    typeof elevation === 'number' ? `Wysokość: ${elevation} m n.p.m.` : undefined,
    url ? `URL: ${url}` : undefined,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  const text = [summary, description].filter((part) => part.length > 0).join('\n\n');
  return expandChunkDrafts({
    source: 'szczyty',
    key,
    title,
    url,
    peakName: name,
    text,
  });
}

export function sourceFromKey(key: string): RagContentSource | undefined {
  if (key.startsWith('blog/')) {
    return 'blog';
  }
  if (key.startsWith('biblioteka-tras/')) {
    return 'biblioteka-tras';
  }
  if (key.startsWith('szlaki-dlugodystansowe/')) {
    return 'szlaki-dlugodystansowe';
  }
  if (key.startsWith('szczyty/')) {
    return 'szczyty';
  }
  return undefined;
}

export function parseR2JsonObject(key: string, rawJson: string): RagChunkDraft[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const source = sourceFromKey(key);
  if (source === 'blog') {
    return parseBlogJson(key, record);
  }
  if (source === 'biblioteka-tras') {
    return parsePlanJson(key, record);
  }
  if (source === 'szlaki-dlugodystansowe') {
    return parseLongDistanceJson(key, record);
  }
  if (source === 'szczyty') {
    return parsePeakJson(key, record);
  }
  return [];
}

export function embeddingInputForChunk(
  chunk: Pick<RagChunkDraft, 'title' | 'section' | 'text' | 'source' | 'peakName'>,
): string {
  const header = [chunk.peakName, chunk.title, chunk.section, `Źródło: ${chunk.source}`]
    .filter(Boolean)
    .join(' | ');
  return `${header}\n${chunk.text}`.trim();
}