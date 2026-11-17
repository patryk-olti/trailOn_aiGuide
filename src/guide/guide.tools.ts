import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { D1Service } from '../cloudflare/d1.service';
import { PeakRow } from '../cloudflare/d1.types';
import { RagIndexService } from '../rag/rag-index.service';
import { RAG_MAX_TOOL_TEXT_CHARS } from '../rag/rag.constants';
import { RagContentSource } from '../rag/rag.constants';
import { LOCATION_REQUIRED_TOOL_RESULT } from './guide-location.messages';
import { GuideToolRequestContext } from './guide.types';

const DEFAULT_NEARBY_RADIUS_KM = 100;
const EARTH_RADIUS_KM = 6371;

export const GUIDE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_materials',
      description: 'Szuka fragmentów w materiałach trailON (blog, biblioteka tras, szlaki długodystansowe).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pytanie lub słowa kluczowe po polsku.' },
          source: {
            type: 'string',
            enum: ['blog', 'biblioteka-tras', 'szlaki-dlugodystansowe'],
            description: 'Opcjonalnie zawęź źródło.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 6 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_material',
      description: 'Pobiera szerszy kontekst jednego materiału po id fragmentu z search_materials.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Identyfikator fragmentu (chunkId).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_peaks',
      description:
        'Wyszukuje opublikowane szczyty w katalogu trailON (nazwa, pasmo, wysokość, odległość od pozycji użytkownika).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nazwa lub część nazwy szczytu.' },
          range: { type: 'string', description: 'Opcjonalnie nazwa pasma.' },
          minElevationM: { type: 'integer', description: 'Minimalna wysokość w metrach n.p.m.' },
          maxElevationM: { type: 'integer', description: 'Maksymalna wysokość w metrach n.p.m.' },
          nearLat: { type: 'number', description: 'Szerokość geogr. punktu odniesienia (stopnie).' },
          nearLng: { type: 'number', description: 'Długość geogr. punktu odniesienia (stopnie).' },
          radiusKm: {
            type: 'number',
            description: 'Maks. odległość od nearLat/nearLng w km (domyślnie 100 lub z żądania API).',
          },
          limit: { type: 'integer', minimum: 1, maximum: 8 },
        },
        additionalProperties: false,
      },
    },
  },
];

type ToolArgs = Record<string, unknown>;

export class GuideToolsExecutor {
  constructor(
    private readonly rag: RagIndexService,
    private readonly d1: D1Service,
  ) {}

  async execute(
    name: string,
    rawArguments: string,
    request?: GuideToolRequestContext,
  ): Promise<{ text: string; sourceKeys: string[] }> {
    let args: ToolArgs = {};
    try {
      args = JSON.parse(rawArguments) as ToolArgs;
    } catch {
      return { text: 'Nie udało się odczytać argumentów narzędzia.', sourceKeys: [] };
    }

    if (name === 'search_materials') {
      return this.searchMaterials(args);
    }
    if (name === 'get_material') {
      return this.getMaterial(args);
    }
    if (name === 'search_peaks') {
      return this.searchPeaks(args, request);
    }
    return { text: `Nieznane narzędzie: ${name}`, sourceKeys: [] };
  }

  private async searchMaterials(args: ToolArgs): Promise<{ text: string; sourceKeys: string[] }> {
    const query = readString(args.query);
    if (!query) {
      return { text: 'Brak zapytania do wyszukiwania materiałów.', sourceKeys: [] };
    }
    const limit = clampInt(args.limit, 3, 1, 6);
    const source = readSource(args.source);
    const hits = await this.rag.searchByQuery(query, { source, limit });
    if (hits.length === 0) {
      return { text: 'Brak trafień w materiałach trailON.', sourceKeys: [] };
    }
    const lines = hits.map((hit) => {
      const snippet = truncate(hit.text, 500);
      const section = hit.section ? ` | ${hit.section}` : '';
      const url = hit.url ? ` | ${hit.url}` : '';
      return `id=${hit.id} | ${hit.title}${section}${url}\n${snippet}`;
    });
    return {
      text: truncate(lines.join('\n\n'), RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys: hits.map((hit) => hit.id),
    };
  }

  private getMaterial(args: ToolArgs): { text: string; sourceKeys: string[] } {
    const id = readString(args.id);
    if (!id) {
      return { text: 'Brak identyfikatora materiału.', sourceKeys: [] };
    }
    const material = this.rag.getMaterial(id);
    if (!material) {
      return { text: 'Nie znaleziono materiału o podanym id.', sourceKeys: [] };
    }
    const header = [
      material.title,
      material.section,
      material.url,
      `Źródło: ${material.source}`,
    ]
      .filter(Boolean)
      .join(' | ');
    return {
      text: truncate(`${header}\n${material.content}`, RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys: [material.id],
    };
  }

  private async searchPeaks(
    args: ToolArgs,
    request?: GuideToolRequestContext,
  ): Promise<{ text: string; sourceKeys: string[] }> {
    const table = this.d1.assertTableName(this.d1.peaksTable);
    const limit = clampInt(args.limit, 5, 1, 8);
    const where: string[] = [`status = 'published'`];
    const params: Array<string | number | null> = [];

    const query = readString(args.query);
    if (query) {
      where.push('name LIKE ?');
      params.push(`%${query}%`);
    }
    const range = readString(args.range);
    if (range) {
      where.push('range_name LIKE ?');
      params.push(`%${range}%`);
    }
    const minElevation = readInt(args.minElevationM);
    if (minElevation !== undefined) {
      where.push('elevation_m >= ?');
      params.push(minElevation);
    }
    const maxElevation = readInt(args.maxElevationM);
    if (maxElevation !== undefined) {
      where.push('elevation_m <= ?');
      params.push(maxElevation);
    }

    const toolNearLat = readFloat(args.nearLat);
    const toolNearLng = readFloat(args.nearLng);
    const requestedRadius = readFloat(args.radiusKm);
    const wantsNearby =
      requestedRadius !== undefined || toolNearLat !== undefined || toolNearLng !== undefined;

    const nearLat = toolNearLat ?? request?.location?.lat;
    const nearLng = toolNearLng ?? request?.location?.lng;
    const hasGeo = nearLat !== undefined && nearLng !== undefined;

    if ((wantsNearby || request?.locationMissingForProximity) && !hasGeo) {
      if (toolNearLat !== undefined !== (toolNearLng !== undefined)) {
        return {
          text:
            'Podano tylko jedną współrzędną (nearLat lub nearLng). Do wyszukiwania w promieniu potrzebne są obie albo pole location w żądaniu API. ' +
            LOCATION_REQUIRED_TOOL_RESULT,
          sourceKeys: [],
        };
      }
      return { text: LOCATION_REQUIRED_TOOL_RESULT, sourceKeys: [] };
    }
    const radiusKm = clampFloat(
      readFloat(args.radiusKm) ?? request?.location?.radiusKm ?? (hasGeo ? DEFAULT_NEARBY_RADIUS_KM : undefined),
      DEFAULT_NEARBY_RADIUS_KM,
      1,
      500,
    );

    const hasFilters =
      Boolean(query) ||
      Boolean(range) ||
      minElevation !== undefined ||
      maxElevation !== undefined ||
      hasGeo;
    if (!hasFilters) {
      return {
        text: 'Podaj przynajmniej query, range, zakres wysokości albo wyszukiwanie w pobliżu (nearLat/nearLng + radiusKm lub location w API).',
        sourceKeys: [],
      };
    }

    if (hasGeo && !isValidLatLng(nearLat, nearLng)) {
      return { text: 'Nieprawidłowe współrzędne do wyszukiwania w pobliżu.', sourceKeys: [] };
    }

    type PeakResult = PeakRow & { recommended: number; distance_km?: number };

    let rows: PeakResult[];

    if (hasGeo) {
      const haversineKm = `(${EARTH_RADIUS_KM} * acos(min(1.0, max(-1.0,
        cos(radians(?)) * cos(radians(lat)) * cos(radians(lng) - radians(?)) + sin(radians(?)) * sin(radians(lat))
      ))))`;
      const innerParams = [nearLat, nearLng, nearLat, ...params];
      const sql = `SELECT peak_id, name, elevation_m, range_name, description, recommended, distance_km
        FROM (
          SELECT peak_id, name, elevation_m, range_name, description, recommended,
            ${haversineKm} AS distance_km
          FROM ${table}
          WHERE ${where.join(' AND ')} AND lat IS NOT NULL AND lng IS NOT NULL
        )
        WHERE distance_km <= ?
        ORDER BY distance_km ASC, recommended DESC, elevation_m DESC
        LIMIT ?`;
      rows = await this.d1.query<PeakResult>(sql, [...innerParams, radiusKm, limit]);
    } else {
      const sql = `SELECT peak_id, name, elevation_m, range_name, description, recommended
        FROM ${table}
        WHERE ${where.join(' AND ')}
        ORDER BY recommended DESC, elevation_m DESC
        LIMIT ?`;
      params.push(limit);
      rows = await this.d1.query<PeakResult>(sql, params);
    }

    if (rows.length === 0) {
      return { text: 'Brak szczytów spełniających kryteria.', sourceKeys: [] };
    }

    const lines = rows.map((row) => {
      const description = row.description ? truncate(row.description, 240) : 'Brak opisu.';
      const distance =
        typeof row.distance_km === 'number'
          ? ` | ~${row.distance_km.toFixed(1)} km`
          : '';
      return `${row.name} (${row.elevation_m} m, ${row.range_name}${distance}) | id=${row.peak_id}\n${description}`;
    });
    return {
      text: truncate(lines.join('\n\n'), RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys: rows.map((row) => `peak:${row.peak_id}`),
    };
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
}

function readFloat(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = readFloat(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function readSource(value: unknown): RagContentSource | undefined {
  const raw = readString(value);
  if (raw === 'blog' || raw === 'biblioteka-tras' || raw === 'szlaki-dlugodystansowe') {
    return raw;
  }
  return undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = readInt(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}