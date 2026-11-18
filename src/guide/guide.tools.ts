import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { D1Service } from '../cloudflare/d1.service';
import { PeakRow } from '../cloudflare/d1.types';
import { RagIndexService } from '../rag/rag-index.service';
import { RAG_MAX_TOOL_TEXT_CHARS } from '../rag/rag.constants';
import { RagContentSource, RAG_SOURCE_LOCATIONS } from '../rag/rag.constants';
import { OpenMeteoService } from '../weather/open-meteo.service';
import { runGetPeakWeather } from './guide-weather.tool';
import { LOCATION_REQUIRED_TOOL_RESULT } from './guide-location.messages';
import { GuideSource, GuideToolRequestContext, GuideToolResult } from './guide.types';

const DEFAULT_NEARBY_RADIUS_KM = 100;
const EARTH_RADIUS_KM = 6371;

export const GUIDE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_materials',
      description:
        'Szuka fragmentów w materiałach trailON (blog R2, biblioteka tras, szlaki długodystansowe). Obowiązkowe przy pytaniach o szczyty lub pasma przed udzieleniem odpowiedzi.',
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
        'Wyszukuje opublikowane szczyty w katalogu trailON (Cloudflare D1 / trailon_peaks_blob): nazwa, pasmo, wysokość, opis, link do blogu. Używaj range np. „Karkonosze” przy pytaniach o pasmo. Domyślnie zwracaj maks. 3 szczyty (limit), chyba że użytkownik prosi o więcej.',
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
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_peak_weather',
      description:
        'Pobiera pogodę dla szczytu z katalogu trailON lub podanych współrzędnych. Dane z Open-Meteo (jak karta pogody w aplikacji TrailOn / repo peak). scope=current: warunki teraz; scope=weekend: prognoza na najbliższą sobotę lub niedzielę (południe, Europe/Warsaw). Używaj przy pytaniach o temperaturę, wiatr, opady i czy warto iść w góry.',
      parameters: {
        type: 'object',
        properties: {
          peak_id: { type: 'string', description: 'Identyfikator szczytu z search_peaks (peak_id).' },
          peak_name: { type: 'string', description: 'Nazwa lub fragment nazwy szczytu.' },
          lat: { type: 'number', description: 'Szerokość geogr. (gdy brak peak_id / peak_name).' },
          lng: { type: 'number', description: 'Długość geogr. (gdy brak peak_id / peak_name).' },
          scope: {
            type: 'string',
            enum: ['current', 'weekend'],
            description: 'current (domyślnie) lub weekend.',
          },
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
    private readonly weather: OpenMeteoService,
  ) {}

  async execute(
    name: string,
    rawArguments: string,
    request?: GuideToolRequestContext,
  ): Promise<GuideToolResult> {
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
    if (name === 'get_peak_weather') {
      return runGetPeakWeather(args, this.d1, this.weather);
    }
    return { text: `Nieznane narzędzie: ${name}`, sourceKeys: [] };
  }

  private async searchMaterials(args: ToolArgs): Promise<GuideToolResult> {
    const query = readString(args.query);
    if (!query) {
      return { text: 'Brak zapytania do wyszukiwania materiałów.', sourceKeys: [] };
    }
    const limit = clampInt(args.limit, 3, 1, 6);
    const source = readSource(args.source);
    const hits = await this.rag.searchByQuery(query, {
      source,
      sources: source ? undefined : ['blog', 'biblioteka-tras', 'szlaki-dlugodystansowe'],
      limit,
    });
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
      sources: hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        source: RAG_SOURCE_LOCATIONS[hit.source],
        url: hit.url,
      })),
    };
  }

  private getMaterial(args: ToolArgs): GuideToolResult {
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
      `Źródło: ${RAG_SOURCE_LOCATIONS[material.source]}`,
    ]
      .filter(Boolean)
      .join(' | ');
    return {
      text: truncate(`${header}\n${material.content}`, RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys: [material.id],
      sources: [
        {
          id: material.id,
          title: material.title,
          source: RAG_SOURCE_LOCATIONS[material.source],
          url: material.url,
        },
      ],
    };
  }

  private async searchPeaks(
    args: ToolArgs,
    request?: GuideToolRequestContext,
  ): Promise<GuideToolResult> {
    const table = this.d1.assertTableName(this.d1.peaksTable);
    const limit = clampInt(args.limit, 3, 1, 20);
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

    if (wantsNearby && !hasGeo) {
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

    const blogLinkMinScore = 0.22;

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
      const sql = `SELECT peak_id, name, elevation_m, range_name, description, recommended, tags_json, distance_km
        FROM (
          SELECT peak_id, name, elevation_m, range_name, description, recommended, tags_json,
            ${haversineKm} AS distance_km
          FROM ${table}
          WHERE ${where.join(' AND ')} AND lat IS NOT NULL AND lng IS NOT NULL
        )
        WHERE distance_km <= ?
        ORDER BY distance_km ASC, recommended DESC, elevation_m DESC
        LIMIT ?`;
      rows = await this.d1.query<PeakResult>(sql, [...innerParams, radiusKm, limit]);
    } else {
      const sql = `SELECT peak_id, name, elevation_m, range_name, description, recommended, tags_json
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

    const sources: GuideSource[] = [];
    const lines: string[] = [];
    const sourceKeys: string[] = [];
    let embeddingCalls = 0;

    const resolved = [];
    for (const row of rows) {
      const blogPost = this.rag.findBlogForPeakName(row.name);
      let blogUrl = blogPost?.url ?? blogUrlFromTags(row.tags_json);
      if (!blogUrl) {
        blogUrl = await this.findBlogUrlForPeak(row.name, row.range_name, blogLinkMinScore);
        embeddingCalls += 1;
      }
      resolved.push({ row, blogPost, blogUrl });
    }

    // Jeśli mamy jakiekolwiek wpisy blogowe, zwracamy tylko te szczyty — to źródło prawdy.
    const withBlog = resolved.filter((entry) => Boolean(entry.blogUrl));
    const chosen = withBlog.length > 0 ? withBlog : resolved;

    for (const { row, blogPost, blogUrl } of chosen) {
      if (blogUrl) {
        sources.push({
          id: row.peak_id,
          title: row.name,
          source: RAG_SOURCE_LOCATIONS.szczyty,
          url: blogUrl,
        });
      } else {
        sources.push({
          id: row.peak_id,
          title: row.name,
          source: RAG_SOURCE_LOCATIONS.szczyty,
        });
      }
      sourceKeys.push(`peak:${row.peak_id}`);

      let blogExcerpt = '';
      if (blogPost) {
        sources.push({
          id: blogPost.chunkId,
          title: blogPost.title,
          source: RAG_SOURCE_LOCATIONS.blog,
          url: blogPost.url,
        });
        sourceKeys.push(blogPost.chunkId);
        const material = this.rag.getMaterial(blogPost.chunkId);
        if (material) {
          blogExcerpt = `\nMateriał blogowy (priorytet — użyj tej treści i dokładnego URL): ${blogPost.url ?? 'brak url'}\n${truncate(material.content, 520)}`;
        }
      }

      const description = row.description ? truncate(row.description, 240) : 'Brak opisu.';
      const distance =
        typeof row.distance_km === 'number'
          ? ` | ~${row.distance_km.toFixed(1)} km`
          : '';
      const blogPart = blogUrl ? ` | url bloga (kopiuj dosłownie): ${blogUrl}` : '';
      lines.push(
        `${row.name} (${row.elevation_m} m, ${row.range_name}${distance}) | id=${row.peak_id}${blogPart}\nKatalog D1: ${description}${blogExcerpt}`,
      );
    }
    return {
      text: truncate(lines.join('\n\n'), RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys,
      sources,
      embeddingCalls,
    };
  }

  private async findBlogUrlForPeak(
    name: string,
    rangeName: string,
    minScore: number,
  ): Promise<string | undefined> {
    const fromIndex = this.rag.findBlogForPeakName(name);
    if (fromIndex?.url) {
      return fromIndex.url;
    }
    const hits = await this.rag.searchByQuery(`${name} ${rangeName}`, {
      source: 'blog',
      limit: 3,
      minScore,
    });
    return hits.find((hit) => hit.url)?.url;
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

function blogUrlFromTags(tagsJson: string | null | undefined): string | undefined {
  if (!tagsJson?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return (
      readString(record.url) ?? readString(record.blog_url) ?? readString(record.blogUrl)
    );
  } catch {
    return undefined;
  }
}