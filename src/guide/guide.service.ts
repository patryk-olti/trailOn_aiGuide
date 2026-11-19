import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationHistoryService } from '../conversation/conversation-history.service';
import { D1Service } from '../cloudflare/d1.service';
import { OpenAiService } from '../openai/openai.service';
import { ChatMessage, TokenUsage } from '../openai/openai.types';
import { OpenMeteoService } from '../weather/open-meteo.service';
import { RagIndexService } from '../rag/rag-index.service';
import { RagSearchHit } from '../rag/rag.types';
import { RAG_SOURCE_LOCATIONS } from '../rag/rag.constants';
import { CreateGuideDto } from './dto/create-guide.dto';
import { GUIDE_TOOLS, GuideToolsExecutor } from './guide.tools';
import { planCatalogPrefetch } from './guide-catalog.prefetch';
import {
  blogUrlKey,
  buildUrlTitleMap,
  collectCitedBlogUrls,
  isTrailonBlogUrl,
  plainTextToGuideHtml,
  suppressRepeatedBlogLinks,
  trailonGuideAnchor,
} from './guide-response-html';
import { GuideReply, GuideSource, GuideToolRequestContext, GuideUsage } from './guide.types';

const SYSTEM_PROMPT = `Jesteś przewodnikiem AI TrailOn. Pomagasz układać trasy i korzystasz z materiałów zespołu trailON (blog, biblioteka tras, szlaki długodystansowe) oraz katalogu szczytów w Cloudflare D1.
Odpowiadaj po polsku, konkretnie i praktycznie. Uwzględniaj bezpieczeństwo i realia terenu.

Zasady źródeł (obowiązkowe):
- O szczytach i pasmach odpowiadaj WYŁĄCZNIE na podstawie: sekcji "Najbardziej pasujące materiały", "Dane z katalogu (prefetch)" oraz wyników narzędzi search_peaks i search_materials.
- Gdy w pytaniu pada pasmo lub szczyty, najpierw korzystaj z tych danych; nie twórz listy szczytów z ogólnej wiedzy modelu.
- W odpowiedzi domyślnie wymieniaj MAKSYMALNIE 3 szczyty. Jeśli użytkownik wyraźnie prosi o większą liczbę (np. „wymień 5 szczytów”), możesz podać więcej i dopasować limit w search_peaks.
- Jeśli do szczytu jest wpis blogowy (R2, np. blog/szrenica.json), opisuj szczyt głównie z jego zajawki i kontentu; katalog D1 traktuj jako uzupełnienie (wysokość, pasmo).
- Jeśli opisujesz jakiś szczyt, MUSI istnieć jego URL blogowy w danych (pole url w materiale lub url bloga z katalogu). Jeśli nie ma URL — nie opisuj tego szczytu i napisz wprost, że brak wpisu blogowego.
- Link do bloga kopiuj wyłącznie z pola url w materiale (np. https://trailon.pl/przewodnik/karkonosze/szrenica). Nie wymyślaj ani nie składaj innych adresów.
- W treści możesz wstawić adres bloga skopiowany z pola url w danych (np. przy opisie szczytu); serwis zamieni go na link z tytułem wpisu.
- Dany adres bloga wstaw w rozmowie tylko raz. Jeśli ten sam URL (ten sam szczyt / ten sam wpis) był już w wcześniejszej odpowiedzi, nie wklejaj go ponownie — odpowiedz bez linku. Inny szczyt, z innym adresem, linkuj normalnie przy pierwszej wzmiance.
- Jeśli po narzędziach i prefetch brak wpisów — powiedz to wprost; nie uzupełniaj odpowiedzi z pamięci modelu.
Pogoda:
- Na pytania o pogodę, wiatr, temperaturę na szczycie lub „na weekend” wywołaj get_peak_weather (najpierw search_peaks jeśli nie masz peak_id).
- scope=weekend gdy użytkownik pyta o sobotę, niedzielę lub wyjazd na weekend; w przeciwnym razie scope=current.
- Opisuj wyłącznie dane z narzędzia (Open-Meteo); nie zgaduj prognozy z pamięci modelu.
Format odpowiedzi:
- Nie używaj HTML w treści. Zwróć zwykły tekst z akapitami (puste linie) i listami w formie myślników.
- Sekcje i wyróżnienia oznaczaj jako **Nazwa sekcji** (podwójne gwiazdki) — serwis zamieni to na pogrubienie w HTML.
- Nie dodawaj sekcji "Źródła" — serwis doklei ją automatycznie z dokładnych pól url.`;

function isPeakSourceLabel(source: string): boolean {
  // kompatybilność wsteczna (stare wartości) + nowe "realne miejsca"
  return source === 'szczyty' || source === RAG_SOURCE_LOCATIONS.szczyty;
}

@Injectable()
export class GuideService {
  private readonly maxToolRounds: number;
  private readonly maxCompletionTokens: number;
  private readonly prefetchLimit: number;
  private readonly defaultModel: string;
  private readonly tools: GuideToolsExecutor;

  constructor(
    private readonly openAi: OpenAiService,
    private readonly rag: RagIndexService,
    private readonly conversationHistory: ConversationHistoryService,
    d1: D1Service,
    openMeteo: OpenMeteoService,
    config: ConfigService,
  ) {
    this.maxToolRounds = config.getOrThrow<number>('RAG_TOOL_ROUND_LIMIT');
    this.maxCompletionTokens = config.getOrThrow<number>('RAG_MAX_COMPLETION_TOKENS');
    this.prefetchLimit = config.getOrThrow<number>('RAG_PREFETCH_LIMIT');
    this.defaultModel = config.getOrThrow<string>('OPENAI_MODEL');
    this.tools = new GuideToolsExecutor(rag, d1, openMeteo);
  }

  async reply(dto: CreateGuideDto): Promise<GuideReply> {
    const conversationId = await this.conversationHistory.resolveConversation(
      dto.participantId,
      dto.conversationId,
    );
    const priorTurns = await this.conversationHistory.getRecentTurns(conversationId);

    const usage: GuideUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      completionCalls: 0,
      embeddingCalls: 1,
    };
    const sourceIds = new Set<string>();
    const resolvedSources = new Map<string, GuideSource>();
    const prefetched = await this.rag.searchByQuery(dto.message, {
      limit: this.prefetchLimit,
      sources: ['blog', 'biblioteka-tras', 'szlaki-dlugodystansowe'],
    });

    let system = SYSTEM_PROMPT;
    if (dto.context?.trim()) {
      system += `\n\nDodatkowy kontekst użytkownika:\n${dto.context.trim()}`;
    }
    if (dto.location) {
      const radiusKm = dto.location.radiusKm ?? 100;
      system +=
        `\n\nPozycja użytkownika (GPS): szerokość ${dto.location.lat}, długość ${dto.location.lng}, domyślny promień szczytów ${radiusKm} km.` +
        ' Przy pytaniach o szczyty w pobliżu wywołaj search_peaks z minElevationM i ewentualnie radiusKm; nearLat/nearLng możesz pominąć — użyjemy współrzędnych z żądania.';
    }
    const contextBlock = this.formatPrefetch(prefetched);
    if (contextBlock) {
      system += `\n\nNajbardziej pasujące materiały:\n${contextBlock}`;
      for (const hit of prefetched) {
        sourceIds.add(hit.id);
        this.rememberSource(resolvedSources, {
          id: hit.id,
          title: hit.title,
          source: RAG_SOURCE_LOCATIONS[hit.source],
          url: hit.url,
        });
      }
    }

    const catalogPlan = planCatalogPrefetch(dto.message);
    const toolContext: GuideToolRequestContext = dto.location
      ? {
          location: {
            lat: dto.location.lat,
            lng: dto.location.lng,
            radiusKm: dto.location.radiusKm,
          },
        }
      : {};

    if (catalogPlan) {
      const catalogParts: string[] = [];
      if (catalogPlan.peaks) {
        const peakArgs: Record<string, unknown> = { limit: catalogPlan.peaks.limit };
        if (catalogPlan.peaks.range) {
          peakArgs.range = catalogPlan.peaks.range;
        }
        if (catalogPlan.peaks.query) {
          peakArgs.query = catalogPlan.peaks.query;
        }
        if (catalogPlan.peaks.range || catalogPlan.peaks.query) {
          const peakResult = await this.tools.execute(
            'search_peaks',
            JSON.stringify(peakArgs),
            toolContext,
          );
          usage.embeddingCalls += peakResult.embeddingCalls ?? 0;
          this.absorbToolResult(sourceIds, resolvedSources, peakResult);
          catalogParts.push(`Katalog szczytów (D1):\n${peakResult.text}`);
        }
      }
      const materialResult = await this.tools.execute(
        'search_materials',
        JSON.stringify({
          query: catalogPlan.materials.query,
          limit: catalogPlan.materials.limit,
        }),
        toolContext,
      );
      usage.embeddingCalls += 1;
      this.absorbToolResult(sourceIds, resolvedSources, materialResult);
      catalogParts.push(`Materiały trailON (blog / trasy):\n${materialResult.text}`);
      system += `\n\nDane z katalogu (prefetch — użyj ich w pierwszej kolejności w odpowiedzi):\n${catalogParts.join('\n\n')}`;
    }

    const alreadyCitedBlogs = collectCitedBlogUrls(priorTurns.map((turn) => turn.content));
    if (alreadyCitedBlogs.size > 0) {
      const listed = [...alreadyCitedBlogs].map((url) => `- ${url}`).join('\n');
      system +=
        '\n\nAdresy blogów już podane w tej rozmowie. Nie wstawiaj ich ponownie (ani jako goły URL, ani jako link markdown), nawet jeśli prefetch każe skopiować url bloga. ' +
        'Ten sam szczyt opisz bez linku. Inny szczyt (inny adres spoza listy) linkuj przy pierwszym razie:\n' +
        listed;
    }

    const historyMessages: ChatMessage[] = priorTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...historyMessages,
      { role: 'user', content: dto.message },
    ];

    let latestModel = this.defaultModel;
    let finalText = '';
    let round = 0;

    while (round <= this.maxToolRounds) {
      const result = await this.openAi.complete(messages, {
        tools: GUIDE_TOOLS,
        toolChoice: 'auto',
        maxCompletionTokens: this.maxCompletionTokens,
        temperature: 0.3,
      });
      usage.completionCalls += 1;
      this.mergeUsage(usage, result.usage);
      latestModel = result.model;

      if (result.toolCalls && result.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: result.text ?? '',
          tool_calls: result.toolCalls,
        });
        for (const call of result.toolCalls) {
          const toolResult = await this.tools.execute(call.name, call.arguments, toolContext);
          if (call.name === 'search_materials' || call.name === 'get_material') {
            usage.embeddingCalls += 1;
          }
          if (call.name === 'search_peaks') {
            usage.embeddingCalls += toolResult.embeddingCalls ?? 0;
          }
          this.absorbToolResult(sourceIds, resolvedSources, toolResult);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult.text,
          });
        }
        round += 1;
        continue;
      }

      finalText = result.text?.trim() ?? '';
      break;
    }

    if (!finalText) {
      finalText =
        'Nie udało się przygotować odpowiedzi. Spróbuj przeformułować pytanie lub zawęzić temat.';
    }

    finalText = suppressRepeatedBlogLinks(finalText, alreadyCitedBlogs);
    const sources = this.omitRepeatedBlogSources(
      this.buildSources([...sourceIds], prefetched, resolvedSources),
      alreadyCitedBlogs,
    );

    await this.conversationHistory.appendExchange(conversationId, dto.message, finalText);

    return {
      conversationId,
      response: this.formatHtmlResponse(finalText, sources),
      model: latestModel,
      sources,
      usage,
    };
  }

  private omitRepeatedBlogSources(
    sources: GuideSource[],
    alreadyCitedBlogs: ReadonlySet<string>,
  ): GuideSource[] {
    if (alreadyCitedBlogs.size === 0) {
      return sources;
    }
    return sources.filter((source) => {
      const url = (source.url ?? '').trim();
      if (!url || !isTrailonBlogUrl(url)) {
        return true;
      }
      return !alreadyCitedBlogs.has(blogUrlKey(url));
    });
  }

  private formatHtmlResponse(text: string, sources: GuideSource[]): string {
    const cleaned = this.stripTrailingSourcesSection(text).trim();
    const urlTitles = buildUrlTitleMap(sources);
    const contentHtml = plainTextToGuideHtml(cleaned, urlTitles, (url) =>
      this.rag.findTitleByUrl(url),
    );
    const body = contentHtml;
    return `<div class="trailon-guide-reply">${body}</div>`;
  }

  private stripTrailingSourcesSection(text: string): string {
    // Model czasem generuje "Źródła" i potrafi wymyślać URL-e. Usuwamy WYŁĄCZNIE końcową sekcję.
    const input = text ?? '';
    const re = /(^|\n)#{0,3}\s*Źródła\b/gi;
    let lastStart: number | undefined;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = re.exec(input))) {
      lastStart = match.index + (match[1]?.length ?? 0);
    }
    if (lastStart === undefined) {
      return input;
    }
    // Bezpiecznik: wycinamy tylko jeśli "Źródła" są blisko końca (typowo to ostatnia sekcja).
    if (lastStart < Math.max(0, input.length - 2000)) {
      return input;
    }
    return input.slice(0, lastStart).trimEnd();
  }

  private renderSourcesHtml(sources: GuideSource[]): string {
    const items: Array<{ title: string; url: string }> = [];
    const seen = new Set<string>();

    const push = (title: string, url: string): void => {
      const safeTitle = (title || '').trim() || 'Materiał';
      const safeUrl = (url || '').trim();
      if (!safeUrl) {
        return;
      }
      // Źródłem prawdy są linki trailON (z pól url w blogu/katalogu), nie linki "z internetu".
      if (!safeUrl.startsWith('https://trailon.pl/')) {
        return;
      }
      if (seen.has(safeUrl)) {
        return;
      }
      seen.add(safeUrl);
      items.push({ title: safeTitle, url: safeUrl });
    };

    // Priorytet: szczyty (żeby było 1:1 link do każdego opisywanego szczytu).
    for (const source of sources) {
      if (isPeakSourceLabel(source.source) && source.url) {
        push(source.title, source.url);
      }
    }
    // Fallback: materiały (blog/trasy), jeśli nie ma szczytów z URL.
    if (items.length === 0) {
      for (const source of sources) {
        if (!isPeakSourceLabel(source.source) && source.url) {
          push(source.title, source.url);
        }
      }
    }

    if (items.length === 0) {
      return '';
    }

    const lis = items
      .map((item) => trailonGuideAnchor(item.url, item.title))
      .map((anchor) => `<li>${anchor}</li>`)
      .join('');

    return `<h3>Źródła</h3><ul>${lis}</ul>`;
  }

  private absorbToolResult(
    sourceIds: Set<string>,
    resolvedSources: Map<string, GuideSource>,
    toolResult: { sourceKeys: string[]; sources?: GuideSource[]; embeddingCalls?: number },
  ): void {
    for (const key of toolResult.sourceKeys) {
      sourceIds.add(key);
    }
    for (const source of toolResult.sources ?? []) {
      const mapKey = isPeakSourceLabel(source.source) ? `peak:${source.id}` : source.id;
      this.rememberSource(resolvedSources, source, mapKey);
    }
  }

  private rememberSource(
    resolvedSources: Map<string, GuideSource>,
    source: GuideSource,
    mapKey?: string,
  ): void {
    const key = mapKey ?? (isPeakSourceLabel(source.source) ? `peak:${source.id}` : source.id);
    const previous = resolvedSources.get(key);
    if (!previous) {
      resolvedSources.set(key, source);
      return;
    }
    if (!previous.url && source.url) {
      resolvedSources.set(key, { ...previous, url: source.url });
    }
  }

  private formatPrefetch(hits: RagSearchHit[]): string {
    if (hits.length === 0) {
      return '';
    }
    return hits
      .map((hit, index) => {
        const header = [
          `${index + 1}. ${hit.title}`,
          hit.section,
          hit.url,
          `id=${hit.id}`,
        ]
          .filter(Boolean)
          .join(' | ');
        return `${header}\n${hit.text}`;
      })
      .join('\n\n');
  }

  private buildSources(
    ids: string[],
    prefetched: RagSearchHit[],
    resolvedSources: Map<string, GuideSource>,
  ): GuideSource[] {
    const out: GuideSource[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (id.startsWith('peak:')) {
        const peakId = id.slice('peak:'.length);
        const key = `peak:${peakId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const known = resolvedSources.get(key);
        out.push(
          known ?? {
            id: peakId,
            title: `Szczyt ${peakId}`,
            source: RAG_SOURCE_LOCATIONS.szczyty,
          },
        );
        continue;
      }
      const knownMaterial = resolvedSources.get(id);
      if (knownMaterial) {
        if (seen.has(knownMaterial.id)) {
          continue;
        }
        seen.add(knownMaterial.id);
        out.push(knownMaterial);
        continue;
      }
      const hit = prefetched.find((row) => row.id === id) ?? this.rag.getMaterial(id);
      if (!hit) {
        continue;
      }
      if (seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      out.push({
        id: hit.id,
        title: hit.title,
        source: RAG_SOURCE_LOCATIONS[hit.source],
        url: hit.url,
      });
    }
    return out;
  }

  private mergeUsage(target: GuideUsage, usage?: TokenUsage): void {
    if (!usage) {
      return;
    }
    target.promptTokens += usage.promptTokens;
    target.completionTokens += usage.completionTokens;
    target.totalTokens += usage.totalTokens;
  }
}