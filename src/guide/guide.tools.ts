import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { D1Service } from '../cloudflare/d1.service';
import { OpenAiService } from '../openai/openai.service';
import { PeakRow } from '../cloudflare/d1.types';
import { BlogPostRef, blogIdentityMatchesPeak } from '../rag/rag-blog-lookup';
import { RagIndexService } from '../rag/rag-index.service';
import { RagSearchHit } from '../rag/rag.types';
import { RAG_MAX_TOOL_TEXT_CHARS } from '../rag/rag.constants';
import { RagContentSource, RAG_SOURCE_LOCATIONS } from '../rag/rag.constants';
import { OpenMeteoService } from '../weather/open-meteo.service';
import { runGetPeakWeather } from './guide-weather.tool';
import { LOCATION_REQUIRED_TOOL_RESULT } from './guide-location.messages';
import {
  coordinatesForDeparture,
  runPeakFocus,
  runRangesBeside,
  runSearchLocality,
  runSuggestNearbyRanges,
} from './guide-nearby-ranges';
import type { StatedDeparture } from './guide-nearby-ranges';
import { formatMountainWebBrief } from './guide-web-search';
import { LibraryRoutesService } from './library-routes.service';
import { MOUNTAIN_INDUSTRY_DOMAINS } from './mountain-sources';
import { peakMapUrl } from './guide-response-html';
import { GuideSource, GuideToolRequestContext, GuideToolResult } from './guide.types';

const DEFAULT_NEARBY_RADIUS_KM = 100;
const EARTH_RADIUS_KM = 6371;

export const GUIDE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'suggest_nearby_ranges',
      description:
        'Tylko gdy użytkownik pyta, dokąd jechać w góry, i nie nazywa pasma ani szczytu. Np. „Chcę pojechać w góry, co proponujesz?” albo sama miejscowość jako punkt startu. Nie wołaj tego przy pytaniu o konkretne pasmo, szczyt, co jest obok albo co polecasz w nazwanym paśmie. Nazwa szczytu nie jest nową miejscowością. Punkt startu: miejscowość już podana w wątku, a gdy jej nie ma — GPS. Zwraca maksymalnie 3 najbliższe pasma. Bez punktu startu nie zgaduj pasm.',
      parameters: {
        type: 'object',
        properties: {
          locality: {
            type: 'string',
            description: 'Miejscowość w mianowniku, gdy użytkownik nie korzysta z GPS. Np. „Kraków”, nie „z Krakowa”. Bez województwa w tym polu.',
          },
          voivodeship: {
            type: 'string',
            description:
              'Województwo tej miejscowości. Wymagane razem z locality — ta sama nazwa bywa w kilku województwach.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 3, description: 'Ile pasm podać. Domyślnie 3.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_locality',
      description:
        'Szuka miejscowości w Polsce, gdy użytkownik podaje skąd jedzie. Przyjmuje wypowiedź tak jak ją napisał: „Głogów woj. dolnośląskie”, „jadę z Głogowa z dolnośląskiego”, samą odmianę „Głogowa”. Zwraca nazwę w mianowniku i województwo. Nie zgaduj współrzędnych. Gdy wynik wymienia kilka województw albo mówi, że tej nazwy nie ma w podanym, nie wybieraj innego. Po ustaleniu miejscowości wywołaj suggest_nearby_ranges z locality i voivodeship z wyniku.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Miejscowość albo cała wypowiedź użytkownika, np. „Głogów woj. dolnośląskie”.',
          },
          voivodeship: {
            type: 'string',
            description: 'Województwo, jeśli jest podane osobno. Może być w odmianie, np. „dolnośląskiego”.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_materials',
      description:
        'Krok 1. Zawsze pierwsze źródło: blogi trailON. Bez parametru source zwraca najpierw blogi, a potem szlaki. Jeśli blog pokrywa pytanie, odpowiedz z niego i nie sięgaj do szczytów, szlaków ani internetu.',
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
        'Krok 2, po blogu. Katalog szczytów trailON (Cloudflare D1): nazwa, pasmo, wysokość, opis, link do bloga. Używaj, gdy blog nie podaje wysokości, pasma albo listy. range np. „Karkonosze”. Domyślnie maks. 3 szczyty, chyba że użytkownik prosi o więcej. Nie zastępuj treści bloga katalogiem.',
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
        'Pobiera pogodę dla szczytu z katalogu trailON lub podanych współrzędnych. Dane z Open-Meteo (jak karta pogody w aplikacji TrailOn / repo peak). scope=current: warunki teraz; scope=weekend: prognoza na najbliższą sobotę lub niedzielę (południe, Europe/Warsaw). Używaj przy pytaniach o temperaturę, wiatr, opady i czy warto iść w góry. Gdy nie da się podać pogody, wynik zawiera szczyty w promieniu maksymalnie 5 km od punktu użytkownika — dopytaj o nie, nie zgaduj prognozy.',
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
  {
    type: 'function',
    function: {
      name: 'search_library_routes',
      description:
        'Krok 3, po blogu i szczytach. Gotowe plany w bibliotece tras trailON. Wołaj, gdy pytanie jest o trasę, szlak, dojście albo wycieczkę, a blog i katalog szczytów nie dają planu. Zwraca nazwę, trudność, długość i dokładny url. Nie wymyślaj tras spoza wyniku.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nazwa szczytu, pasma albo fragment nazwy trasy, np. „Biskupia Kopa”.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Krok 4, na końcu. Internet dopiero gdy blog, szczyty i szlaki trailON nie zawierają faktu. Treść strony ma wystarczyć na start — nie zastępuj jej siecią. Do zamknięcia szlaku, lawiny, komunikatu parku albo służb, których nie ma w materiałach trailON. Wynik tylko ze źródeł branżowych. Nie używaj do list szczytów, wysokości, opisów z bloga ani tras z biblioteki.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Konkretne pytanie górskie po polsku, np. „komunikat turystyczny TPN Tatry” albo „zagrożenie lawinowe TOPR”.',
          },
        },
        required: ['query'],
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
    private readonly libraryRoutes: LibraryRoutesService,
    private readonly web: OpenAiService,
  ) {}

  async execute(
    name: string,
    rawArguments: string,
    request?: GuideToolRequestContext,
    signal?: AbortSignal,
  ): Promise<GuideToolResult> {
    let args: ToolArgs = {};
    try {
      args = JSON.parse(rawArguments) as ToolArgs;
    } catch {
      return { text: 'Nie udało się odczytać argumentów narzędzia.', sourceKeys: [] };
    }

    if (name === 'search_locality') {
      return runSearchLocality(args, signal);
    }
    if (name === 'suggest_nearby_ranges') {
      return runSuggestNearbyRanges(
        args,
        this.d1,
        request?.location,
        signal,
        request?.departure,
        request?.userMessage,
        request?.placeAnswerExpected,
      );
    }
    if (name === 'search_materials') {
      return this.searchMaterials(args);
    }
    if (name === 'get_material') {
      return this.getMaterial(args);
    }
    if (name === 'search_peaks') {
      return this.searchPeaks(args, request, signal);
    }
    if (name === 'get_peak_weather') {
      const namesAPeak = Boolean(readString(args.peak_id) || readString(args.peak_name));
      const hasCoordinates = readFloat(args.lat) !== undefined && readFloat(args.lng) !== undefined;
      const location =
        namesAPeak || hasCoordinates
          ? request?.location
          : await this.effectiveLocation(request, signal);
      return runGetPeakWeather(args, this.d1, this.weather, location);
    }
    if (name === 'search_library_routes') {
      return this.searchLibraryRoutes(args);
    }
    if (name === 'search_web') {
      return this.searchWeb(args, signal);
    }
    return { text: `Nieznane narzędzie: ${name}`, sourceKeys: [] };
  }

  lookupRangesBeside(
    like: string,
    preferPrefix: string | undefined,
    departure?: StatedDeparture,
  ): Promise<GuideToolResult | undefined> {
    return runRangesBeside(this.d1, like, preferPrefix, departure);
  }

  lookupPeakFocus(name: string, departure?: StatedDeparture): Promise<GuideToolResult | undefined> {
    return runPeakFocus(this.d1, name, departure);
  }

  private async searchWeb(args: ToolArgs, signal?: AbortSignal): Promise<GuideToolResult> {
    const query = readString(args.query);
    if (!query) {
      return { text: 'Podaj pytanie górskie do wyszukania w źródłach branżowych.', sourceKeys: [] };
    }
    try {
      const found = await this.web.searchWeb(query.slice(0, 400), MOUNTAIN_INDUSTRY_DOMAINS, signal);
      const brief = formatMountainWebBrief(found.text, found.hits);
      return {
        text: brief.text,
        sourceKeys: brief.sources.map((source) => source.id),
        sources: brief.sources,
        usage: found.usage,
      };
    } catch (error) {
      if (error instanceof Error && /abort/i.test(error.name)) {
        throw error;
      }
      return {
        text: 'Nie udało się sprawdzić źródeł branżowych. Powiedz użytkownikowi, że nie masz teraz potwierdzonej informacji. Nie zgaduj.',
        sourceKeys: [],
      };
    }
  }

  private async searchLibraryRoutes(args: ToolArgs): Promise<GuideToolResult> {
    const query = readString(args.query);
    if (!query) {
      return { text: 'Podaj nazwę szczytu, pasma albo fragment nazwy trasy.', sourceKeys: [] };
    }
    const limit = clampInt(args.limit, 3, 1, 5);
    try {
      const found = await this.libraryRoutes.search(query, limit);
      return {
        text: found.text,
        sourceKeys: found.routes.map((route) => route.id),
        sources: found.routes.map((route) => ({
          id: route.id,
          title: route.name,
          source: RAG_SOURCE_LOCATIONS['biblioteka-tras'],
          url: route.url,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'nieznany błąd';
      return {
        text: `Nie udało się odczytać biblioteki tras (${message}).`,
        sourceKeys: [],
      };
    }
  }

  private async searchMaterials(args: ToolArgs): Promise<GuideToolResult> {
    const query = readString(args.query);
    if (!query) {
      return { text: 'Brak zapytania do wyszukiwania materiałów.', sourceKeys: [] };
    }
    const limit = clampInt(args.limit, 3, 1, 6);
    const source = readSource(args.source);
    if (source && source !== 'blog') {
      const hits = await this.rag.searchByQuery(query, { source, limit });
      if (hits.length === 0) {
        return { text: 'Brak trafień w szlakach trailON.', sourceKeys: [], embeddingCalls: 1 };
      }
      return { ...this.packMaterialHits(hits), embeddingCalls: 1 };
    }
    if (source === 'blog') {
      const hits = await this.rag.searchByQuery(query, { source: 'blog', limit });
      if (hits.length === 0) {
        return { text: 'Brak trafień w blogach trailON.', sourceKeys: [], embeddingCalls: 1 };
      }
      return { ...this.packMaterialHits(hits), embeddingCalls: 1 };
    }

    const blogs = await this.rag.searchByQuery(query, { source: 'blog', limit });
    const trails = await this.rag.searchByQuery(query, {
      sources: ['biblioteka-tras', 'szlaki-dlugodystansowe'],
      limit,
    });
    const blogBody = blogs.length > 0 ? this.materialLines(blogs, 420) : 'Brak trafień w blogach.';
    const trailBody =
      trails.length > 0 ? this.materialLines(trails, 220) : 'Brak trafień w szlakach.';
    const hits = [...blogs, ...trails];
    return {
      text: truncate(
        `Blogi (pierwsze źródło — jeśli to wystarcza, nie sięgaj dalej):\n${blogBody}\n\nSzlaki (dopiero po blogu i po katalogu szczytów):\n${trailBody}`,
        RAG_MAX_TOOL_TEXT_CHARS,
      ),
      sourceKeys: hits.map((hit) => hit.id),
      sources: hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        source: RAG_SOURCE_LOCATIONS[hit.source],
        url: hit.url,
      })),
      embeddingCalls: 2,
    };
  }

  private packMaterialHits(hits: RagSearchHit[]): GuideToolResult {
    return {
      text: truncate(this.materialLines(hits, 500), RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys: hits.map((hit) => hit.id),
      sources: hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        source: RAG_SOURCE_LOCATIONS[hit.source],
        url: hit.url,
      })),
    };
  }

  private materialLines(
    hits: Array<{ id: string; title: string; section?: string; url?: string; text: string }>,
    snippetChars: number,
  ): string {
    return hits
      .map((hit) => {
        const snippet = truncate(hit.text, snippetChars);
        const section = hit.section ? ` | ${hit.section}` : '';
        const url = hit.url ? ` | ${hit.url}` : '';
        return `id=${hit.id} | ${hit.title}${section}${url}\n${snippet}`;
      })
      .join('\n\n');
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

  private async effectiveLocation(
    request: GuideToolRequestContext | undefined,
    signal?: AbortSignal,
  ): Promise<{ lat: number; lng: number } | undefined> {
    if (request?.resolvedDeparture) {
      return request.resolvedDeparture;
    }
    if (request?.departure) {
      try {
        const point = await coordinatesForDeparture(request.departure, signal);
        if (point) {
          request.resolvedDeparture = point;
          return point;
        }
      } catch (error) {
        if (error instanceof Error && /abort/i.test(error.name)) {
          throw error;
        }
      }
    }
    if (request?.location && isValidLatLng(request.location.lat, request.location.lng)) {
      return { lat: request.location.lat, lng: request.location.lng };
    }
    return undefined;
  }

  private async searchPeaks(
    args: ToolArgs,
    request?: GuideToolRequestContext,
    signal?: AbortSignal,
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

    if (wantsNearby && request?.departure) {
      const point = await this.effectiveLocation(request, signal);
      if (point) {
        request.location = {
          lat: point.lat,
          lng: point.lng,
          radiusKm: request.location?.radiusKm,
        };
      }
    }

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

    const resolved = rows.map((row) => ({ row, ...this.confirmedBlogForPeak(row) }));

    for (const { row, blogPost, blogUrl } of resolved) {
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
      const blogPart = blogUrl
        ? ` | url bloga (w odpowiedzi napisz „Link do bloga: ${blogUrl}”, adres kopiuj 1:1)`
        : ' | brak potwierdzonego url bloga — nie podawaj linku do bloga';
      const mapUrl = peakMapUrl(row.peak_id);
      const mapPart = ` | url mapy (w odpowiedzi wklej sam adres w osobnej linii, 1:1: ${mapUrl})`;
      lines.push(
        `${row.name} (${row.elevation_m} m.n.p.m.) | pasmo: ${row.range_name}${distance} | id=${row.peak_id}${blogPart}${mapPart}\nKatalog D1: ${description}${blogExcerpt}`,
      );
    }
    return {
      text: truncate(lines.join('\n\n'), RAG_MAX_TOOL_TEXT_CHARS),
      sourceKeys,
      sources,
      peaks: rows.map((row) => ({ id: row.peak_id, name: row.name, elevationM: row.elevation_m })),
    };
  }

  private confirmedBlogForPeak(row: { name: string; tags_json?: string | null }): {
    blogPost?: BlogPostRef;
    blogUrl?: string;
  } {
    const indexed = this.rag.findBlogForPeakName(row.name);
    if (indexed?.url && blogIdentityMatchesPeak(row.name, { url: indexed.url })) {
      return { blogPost: indexed, blogUrl: indexed.url };
    }
    const fromTags = blogUrlFromTags(row.tags_json);
    if (fromTags && blogIdentityMatchesPeak(row.name, { url: fromTags })) {
      return { blogUrl: fromTags };
    }
    return {};
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