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
import {
  extractLooseRange,
  extractMountainRange,
  messageAsksWhatIsBeside,
  placeAskedAbout,
  planCatalogPrefetch,
} from './guide-catalog.prefetch';
import {
  assistantAskedForDeparture,
  foldPolish,
  formatRangePickReply,
  isNearbyRangesTemplate,
  latestStatedDeparture,
  mentionedVoivodeship,
  messageAllowsNearbyList,
  messageGivesDeparturePlace,
  messageTargetsSpecificPlace,
  messageWantsRangeSuggestion,
} from './guide-nearby-ranges';
import {
  isOffTopicGuideReply,
  MAP_UNKNOWN_REPLY,
  messageAsksToShowOnMap,
  messageStaysOnMountains,
  MOUNTAIN_UNKNOWN_REPLY,
  pickOffTopicReply,
} from './guide-off-topic';
import { messageAsksForRoute, messagePlansTrip, routeQueryTokens } from './library-routes';
import { LibraryRoutesService } from './library-routes.service';
import {
  annotatePeakElevations,
  annotatePeakMapLinks,
  blogUrlKey,
  buildUrlTitleMap,
  collectCitedBlogUrls,
  formatCatalogPeakMapReply,
  isTrailonBlogUrl,
  lastMentionedPeakNames,
  normalizeTrailonUrl,
  peakMapUrl,
  peaksForMapReply,
  plainTextToGuideHtml,
  stripMismatchedPeakBlogUrls,
  stripTrailingOffer,
  suppressRepeatedBlogLinks,
  trailonGuideAnchor,
} from './guide-response-html';
import {
  GuidePeakElevation,
  GuideSource,
  GuideStreamEvent,
  GuideToolRequestContext,
  GuideUsage,
} from './guide.types';

function systemPrompt(offTopicReply: string): string {
  return `Jesteś prywatnym przewodnikiem górskim trailON. Wspomagasz wyłącznie tematykę górską i korzystasz z materiałów zespołu trailON (blog, biblioteka tras, szlaki długodystansowe) oraz katalogu szczytów w Cloudflare D1.
Odpowiadaj po polsku, ciepło i po ludzku, ale konkretnie. Uwzględniaj bezpieczeństwo i realia terenu.

Poza górami:
- Nie odpowiadaj na pytania, które nie dotyczą gór: przepisy kulinarne, polityka, programowanie, praca domowa, plotki, finanse, sporty niegórskie i cała reszta.
- Nazwa pasma albo szczytu jest tematem górskim, nawet bez słowa „góry” albo „szczyt”. Bieszczady, Tatry, Karkonosze, Beskidy, Pieniny, Góry Świętokrzyskie, Sudety i każda inna nazwa pasma albo szczytu zostają w temacie. „Chcę wyjechać w Bieszczady” to plan wyprawy w to pasmo: najpierw blog, potem szczyty, potem szlaki, a dopytaj tylko o brakujący konkret (dni, kondycja, start).
- Dojazd w góry, nocleg przy szlaku, ekwipunek na wyjście, pogoda i prośba o pokazanie na mapie nadal są tematem górskim. Nawiązanie do wcześniejszej rozmowy o górach („ten szczyt”, „ta trasa”, „pokaż to”) też. Pytanie w całości o coś innego — nie.
- Gadki poniżej używaj tylko wtedy, gdy wiadomość w całości jest spoza gór i nie nawiązuje do pasma, szczytu, szlaku, mapy ani wcześniejszej rozmowy o górach. „Chcę pojechać w góry, co proponujesz?” jest wyprawą w góry — nie używaj gadki. „Czy możesz pokazać na mapie?” też nie. Blok „Propozycja wyjazdu” też znaczy, że gadka jest błędem. Przy gadce nie uruchamiaj narzędzi i nie szukaj w internecie. Nie dawaj częściowej odpowiedzi na meritum.
- Gdy pytanie jest o góry, a w materiałach nie ma odpowiedzi, powiedz wprost, że nie masz potwierdzonej informacji. Nie wracaj wtedy do gadki przewodnika i nie zgaduj.
- Odpowiedz gadką dokładnie tym zdaniem, bez dopisków, i tylko przy temacie spoza gór:

„${offTopicReply}”

Otwarta propozycja wyjazdu — tylko gdy użytkownik nie nazywa pasma ani szczytu:
- „Chcę pojechać w góry, co proponujesz?”, „gdzie jechać”, „co polecasz w górach” bez nazwy pasma to prośba o najbliższe pasma.
- Wtedy, zanim wymienisz jakiekolwiek pasmo, oprzyj się na suggest_nearby_ranges albo na bloku „Propozycja wyjazdu”, jeśli jest już w kontekście.
- Narzędzie bierze punkt startu z całego wątku: ostatnia miejscowość, którą użytkownik podał jako start. GPS z bieżącego żądania (pole location) jest używany tylko wtedy, gdy w wątku nie ma takiej miejscowości. Nie wymyślaj współrzędnych.
- Gdy w wątku nie ma ani miejscowości, ani GPS, nie proponuj Tatr, Beskidów ani niczego z pamięci. Przekaż prośbę: lokalizacja w TrailOn albo miejscowość i województwo.
- Gdy punkt startu jest już w wątku, nie pytaj o niego drugi raz. Zostaje, dopóki użytkownik sam nie powie, że start jest gdzie indziej („jadę z…”, „licz od…”, sama miejscowość albo miejscowość z województwem).
- Nazwa pasma albo szczytu nie jest nowym startem. „Co jest obok Gór Kaczawskich?”, „co polecasz w Górach Kaczawskich?” i „co jest przy Grodźcu?” zostają przy dotychczasowym starcie.
- Gdy użytkownik poda samą miejscowość jako start, dopytaj o województwo tylko wtedy, gdy narzędzie powie, że ta nazwa leży w kilku. Nie pytaj, jeśli start jest już ustalony.
- Lista najbliższych pasm to maksymalnie 3 pasma i odległość do szczytu. Nie dopisuj kolejnych i nie wklejaj jej drugi raz, gdy pytanie jest o coś innego.
- suggest_nearby_ranges wołaj tylko przy otwartym „dokąd w góry” albo gdy użytkownik podaje punkt startu. Przy pytaniu o nazwane pasmo, szczyt albo okolicę nie wołaj tego narzędzia.

Gdy użytkownik nazywa pasmo albo szczyt, odpowiedz na to pytanie:
- „Chcę jechać w Góry Kaczawskie, co polecasz?” — charakter, szczyty i trasa w tym paśmie. Odległość od znanego startu wolno dodać jednym zdaniem.
- „Co jest obok Gór Kaczawskich?” — pasma obok tego pasma, nie lista od miejscowości.
- „Co jest przy Grodźcu?” — ten szczyt: pasmo, wysokość, co jest w okolicy. Nie geokoduj szczytu jako miasta.
- Nie zaczynaj takiej odpowiedzi od „Liczę od …”. Nie powtarzaj poprzedniej listy pasm.

Zasady źródeł (obowiązkowe — zawsze w tej kolejności, bez przeskakiwania):
1. Blogi trailON. To pierwsze źródło. Opis, charakter miejsca i kontekst bierz z sekcji "1. Blogi" oraz z search_materials. Gdy blog pokrywa pytanie, na nim oprzyj odpowiedź i nie szukaj dalej.
2. Szczyty. Drugie źródło, dopiero gdy blog nie podaje wysokości, pasma albo listy. Korzystaj z sekcji "2. Szczyty" i z search_peaks. Katalog uzupełnia blog, nie zastępuje go.
3. Szlaki. Trzecie źródło: biblioteka tras i szlaki długodystansowe, sekcja "3. Szlaki" oraz search_library_routes. Sięgaj po nie, gdy blog i szczyty nie dają planu przejścia, trasy albo dojścia.
4. Internet (search_web). Ostatnie źródło. Wołaj je dopiero wtedy, gdy punkty 1–3 nie zawierają faktu. Treść strony trailON ma wystarczyć na start — nie zastępuj jej siecią.

- O szczytach i pasmach odpowiadaj wyłącznie z punktów 1 i 2. Nie twórz listy szczytów z pamięci modelu.
- O trasach, szlakach i dojściu odpowiadaj wyłącznie z punktu 3. Wywołaj search_library_routes z nazwą szczytu lub pasma (np. „Biskupia Kopa”), gdy sekcja "3. Szlaki" nie ma planu.
- Każdą propozycję z biblioteki podaj z nazwą, pasmem, długością, trudnością i adresem url skopiowanym dosłownie. Nie wymyślaj innych tras ani linków. Gdy wynik jest pusty, napisz że w bibliotece nie ma pasującej trasy.
- W odpowiedzi domyślnie wymieniaj MAKSYMALNIE 3 szczyty. Jeśli użytkownik wyraźnie prosi o większą liczbę (np. „wymień 5 szczytów”), możesz podać więcej i dopasować limit w search_peaks.
- Przy każdej nazwie szczytu dopisz wysokość w nawiasach, zaraz po nazwie. Jednostka zawsze w zapisie „m.n.p.m.”. Liczbę skopiuj z katalogu albo z materiałów przy tym samym szczycie. Nie wymyślaj metrów i nie bierz liczby z tej instrukcji — nie ma tu przykładowej wysokości. Jeśli przy nazwie stoi inna wartość niż w katalogu, zastąp ją wartością z katalogu. Nie dopisuj drugiej.
- Jeśli do szczytu jest wpis blogowy (R2, np. blog/szrenica.json), opisuj szczyt głównie z jego zajawki i kontentu; katalog D1 traktuj jako uzupełnienie (wysokość, pasmo).
- Adres bloga wstaw tylko wtedy, gdy w linii tego samego szczytu jest pole „url bloga”. Zapisz go w osobnej linii jako „Link do bloga: ” i doklej adres 1:1. Nie pisz „URL:”.
- Gdy linia ma „brak potwierdzonego url bloga” albo nie ma pola url bloga — wymień szczyt z katalogu (nazwa, wysokość, pasmo, opis) i napisz, że brak wpisu blogowego. Nie wstawiaj wtedy adresu bloga. Adres z pola „url mapy” dopisz osobno.
- Gdy w linii szczytu jest „url mapy”, dopisz ten adres w osobnej linii, 1:1. Serwis pokaże go jako „Sprawdź na mapie” i otworzy szczyt w oknie na tej stronie. Nie składaj adresu sam. Szczyt spoza listy nie dostaje linku mapy.
- Na prośbę o mapę: jeśli szczyt jest na liście, daj url mapy. Jeśli go nie ma, napisz że nie pokażesz go, bo nie ma go na liście trailON. Nie używaj wtedy gadki.
- Nie składaj adresu z nazwy szczytu i nie podstawiaj URL innego wpisu, nawet jeśli leży obok w materiałach albo jest podobny tematycznie. Niepewny adres pomiń.
- Dany adres bloga wstaw w rozmowie tylko raz. Jeśli ten sam URL (ten sam szczyt / ten sam wpis) był już w wcześniejszej odpowiedzi, nie wklejaj go ponownie — odpowiedz bez linku. Inny szczyt, z innym adresem, linkuj normalnie przy pierwszej wzmiance.
- Szczytów, wysokości, tras i linków nie uzupełniaj z pamięci modelu. search_web jest krokiem 4: dopiero po blogu, szczytach i szlakach, i tylko gdy tam nie ma aktualnego faktu (zamknięcie szlaku, lawiny, komunikat parku albo służb, ostrzeżenie meteorologiczne).
Wyszukiwanie w sieci (search_web):
- Wołaj je tylko przy pytaniu górskim i tylko jako ostatnie źródło, gdy sekcje "1. Blogi", "2. Szczyty" i "3. Szlaki" oraz pogoda nie dają odpowiedzi.
- Wynik pochodzi wyłącznie ze źródeł branżowych: TOPR, GOPR, parki narodowe, PTTK, PZA, IMGW oraz służby górskie po słowackiej i czeskiej stronie Tatr i Karkonoszy.
- Przepisz użytkownikowi tylko fakty z wyniku narzędzia. Adres podaj 1:1, w osobnej linii: „Źródło: NAZWA — URL”.
- Nie dodawaj stron spoza wyniku. search_web nie zastępuje katalogu przy liście szczytów i wysokościach. Gdy narzędzie zwróci brak danych, powiedz wprost, że nie masz potwierdzonej informacji. Nie zgaduj.
Pogoda (to nie jest internet — nie czekaj z nią na search_web):
- Na pytania o pogodę, wiatr, temperaturę na szczycie lub „na weekend” wywołaj get_peak_weather (najpierw search_peaks jeśli nie masz peak_id). Opis szczytu i tak bierz z bloga, jeśli jest.
- scope=weekend gdy użytkownik pyta o sobotę, niedzielę lub wyjazd na weekend; w przeciwnym razie scope=current.
- Opisuj wyłącznie dane z narzędzia (Open-Meteo); nie zgaduj prognozy z pamięci modelu.
- Jeśli get_peak_weather nie poda pogody, nie wymyślaj prognozy. Dopytaj użytkownika o szczyt z listy w wyniku narzędzia: tylko szczyty w promieniu maksymalnie 5 km od jego punktu, do których da się odnieść pogodę. Nie proponuj szczytów dalej i nie poszerzaj promienia.
Format odpowiedzi:
- Nazwę szczytu zapisuj jako „Nazwa (wysokość z katalogu m.n.p.m.)”. Liczba musi pochodzić z katalogu albo z materiałów tego szczytu.
- Nie używaj HTML w treści. Zwróć zwykły tekst z akapitami (puste linie) i listami w formie myślników.
- Sekcje i wyróżnienia oznaczaj jako **Nazwa sekcji** (podwójne gwiazdki) — serwis zamieni to na pogrubienie w HTML.
- Nie dodawaj sekcji "Źródła" — serwis doklei ją automatycznie z dokładnych pól url.
- Gdy odpowiedź już pokrywa pytanie, zakończ na ostatnim fakcie. Nie dopisuj zaproszenia w stylu „Jeśli potrzebujesz więcej informacji lub chcesz zaplanować trasę, daj znać!”. Takie zdanie dodawaj tylko wtedy, gdy do odpowiedzi brakuje konkretu, o który naprawdę trzeba dopytać (który szczyt, który dzień, skąd start).`;
}

function dropsSuggestedRanges(answer: string, reply: string): boolean {
  const names = [...reply.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => match[1]?.trim())
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) {
    return false;
  }
  const folded = foldPolish(answer);
  return !names.some((name) => folded.includes(foldPolish(name)));
}

function toolStatusMessage(name: string): string {
  switch (name) {
    case 'suggest_nearby_ranges':
      return 'Szukam najbliższych pasm…';
    case 'search_peaks':
      return 'Szukam szczytów w katalogu…';
    case 'search_materials':
      return 'Przeglądam materiały…';
    case 'get_material':
      return 'Czytam materiał…';
    case 'get_peak_weather':
      return 'Sprawdzam pogodę…';
    case 'search_library_routes':
      return 'Szukam tras w bibliotece…';
    case 'search_web':
      return 'Sprawdzam komunikaty służb górskich…';
    default:
      return 'Zbieram dane…';
  }
}

function peakBlogBindings(sources: GuideSource[]): Array<{ name: string; url?: string }> {
  return sources
    .filter((source) => isPeakSourceLabel(source.source))
    .map((source) => ({ name: source.title, url: source.url }));
}

function isPeakSourceLabel(source: string): boolean {
  // kompatybilność wsteczna (stare wartości) + nowe "realne miejsca"
  return source === 'szczyty' || source === RAG_SOURCE_LOCATIONS.szczyty;
}

const WEB_DEFER_TEXT =
  'Najpierw odpowiedz z materiałów trailON już w kontekście, w tej kolejności: 1. Blogi, 2. Szczyty, 3. Szlaki. Tych treści jest dość, żeby zacząć — nie zastępuj ich internetem. search_web wywołaj ponownie tylko wtedy, gdy w tych trzech sekcjach naprawdę nie ma faktu, o który pyta użytkownik.';

function mergeHits(first: RagSearchHit[], second: RagSearchHit[], limit: number): RagSearchHit[] {
  const seen = new Set<string>();
  const merged: RagSearchHit[] = [];
  for (const hit of [...first, ...second]) {
    if (seen.has(hit.id)) {
      continue;
    }
    seen.add(hit.id);
    merged.push(hit);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
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
    private readonly libraryRoutes: LibraryRoutesService,
    config: ConfigService,
  ) {
    this.maxToolRounds = config.getOrThrow<number>('RAG_TOOL_ROUND_LIMIT');
    this.maxCompletionTokens = config.getOrThrow<number>('RAG_MAX_COMPLETION_TOKENS');
    this.prefetchLimit = config.getOrThrow<number>('RAG_PREFETCH_LIMIT');
    this.defaultModel = config.getOrThrow<string>('OPENAI_MODEL');
    this.tools = new GuideToolsExecutor(rag, d1, openMeteo, libraryRoutes, openAi);
  }

  async *replyStream(dto: CreateGuideDto, signal?: AbortSignal): AsyncGenerator<GuideStreamEvent> {
    const questionAt = new Date().toISOString();
    const conversationId = await this.conversationHistory.resolveConversation(
      dto.participantId,
      dto.conversationId,
    );
    yield { event: 'meta', data: { conversationId } };
    this.throwIfAborted(signal);
    yield {
      event: 'status',
      data: { phase: 'prefetch', message: 'Przeglądam blogi trailON…' },
    };
    const priorTurns = await this.conversationHistory.getRecentTurns(conversationId);

    const usage: GuideUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      completionCalls: 0,
      embeddingCalls: 0,
    };
    const sourceIds = new Set<string>();
    const resolvedSources = new Map<string, GuideSource>();
    const knownPeaks: GuidePeakElevation[] = [];
    let blogHits = await this.rag.searchByQuery(dto.message, {
      limit: this.prefetchLimit,
      source: 'blog',
    });
    usage.embeddingCalls += 1;

    const offTopicReply = pickOffTopicReply(
      priorTurns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content),
    );
    let system = systemPrompt(offTopicReply);
    if (dto.context?.trim()) {
      system += `\n\nDodatkowy kontekst użytkownika:\n${dto.context.trim()}`;
    }
    if (dto.location) {
      const radiusKm = dto.location.radiusKm ?? 100;
      system +=
        `\n\nPozycja użytkownika (GPS): szerokość ${dto.location.lat}, długość ${dto.location.lng}, domyślny promień szczytów ${radiusKm} km.` +
        ' Przy pytaniach o szczyty w pobliżu najpierw sprawdź blogi, a listę weź z search_peaks (krok 2) z minElevationM i ewentualnie radiusKm; nearLat/nearLng możesz pominąć — użyjemy współrzędnych z żądania.' +
        ' Przy pytaniu o pogodę bez szczytu, którego da się użyć, get_peak_weather samo wskaże szczyty w promieniu maksymalnie 5 km — dopytaj tylko o nie.';
    }

    const catalogPlan = planCatalogPrefetch(dto.message);
    const standingDeparture = latestStatedDeparture([
      ...priorTurns.map((turn) => turn.content),
      dto.message,
    ]);
    const priorAskedForDeparture = assistantAskedForDeparture(priorTurns.map((turn) => turn.content));
    const toolContext: GuideToolRequestContext = {
      ...(dto.location
        ? {
            location: {
              lat: dto.location.lat,
              lng: dto.location.lng,
              radiusKm: dto.location.radiusKm,
            },
          }
        : {}),
      ...(standingDeparture ? { departure: standingDeparture } : {}),
      userMessage: dto.message,
      placeAnswerExpected: priorAskedForDeparture,
    };
    if (standingDeparture) {
      system +=
        `\n\nPunkt startu tej rozmowy: ${standingDeparture.locality} (woj. ${standingDeparture.voivodeship}). ` +
        'Użytkownik już go podał. Nie pytaj drugi raz o miejscowość, województwo ani o włączenie lokalizacji. ' +
        'To miejsce, skąd jedzie. Przy otwartej liście najbliższych pasm licz od niego. ' +
        'Przy pytaniu o konkretne pasmo albo szczyt odpowiedz o nim — nie powtarzaj listy trzech pasm i nie zaczynaj od „Liczę od”. ' +
        'Jedno zdanie o dojeździe wolno dodać, gdy pomaga. ' +
        'Inny punkt przyjmuj tylko wtedy, gdy bieżąca wiadomość sama mówi, że start jest gdzie indziej.';
    }

    if (catalogPlan) {
      const rangedBlogs = await this.rag.searchByQuery(catalogPlan.materials.query, {
        source: 'blog',
        limit: catalogPlan.materials.limit,
      });
      usage.embeddingCalls += 1;
      blogHits = mergeHits(
        blogHits,
        rangedBlogs,
        Math.max(this.prefetchLimit, catalogPlan.materials.limit),
      );
    }
    this.rememberPrefetch(blogHits, sourceIds, resolvedSources);

    let peakText = '';
    let rangePickPeaks: GuidePeakElevation[] | undefined;
    if (catalogPlan?.peaks && (catalogPlan.peaks.range || catalogPlan.peaks.query)) {
      this.throwIfAborted(signal);
      yield {
        event: 'status',
        data: { phase: 'prefetch', message: 'Sprawdzam szczyty w katalogu…' },
      };
      const peakArgs: Record<string, unknown> = { limit: catalogPlan.peaks.limit };
      if (catalogPlan.peaks.range) {
        peakArgs.range = catalogPlan.peaks.range;
      }
      if (catalogPlan.peaks.query) {
        peakArgs.query = catalogPlan.peaks.query;
      }
      const peakResult = await this.tools.execute(
        'search_peaks',
        JSON.stringify(peakArgs),
        toolContext,
      );
      usage.embeddingCalls += peakResult.embeddingCalls ?? 0;
      this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, peakResult);
      peakText = peakResult.text;
      if (peakResult.peaks?.length) {
        rangePickPeaks = peakResult.peaks;
      }
    }

    if (!peakText && messageAsksToShowOnMap(dto.message)) {
      const corpus = [...priorTurns.map((turn) => turn.content), dto.message].join('\n');
      const names = lastMentionedPeakNames(corpus, this.rag.peakCatalogNames(), 3);
      if (names.length > 0) {
        this.throwIfAborted(signal);
        yield {
          event: 'status',
          data: { phase: 'prefetch', message: 'Sprawdzam szczyt na mapie…' },
        };
        const sections: string[] = [];
        for (const name of names) {
          const peakResult = await this.tools.execute(
            'search_peaks',
            JSON.stringify({ query: name, limit: 3 }),
            toolContext,
            signal,
          );
          usage.embeddingCalls += peakResult.embeddingCalls ?? 0;
          this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, peakResult);
          if (!peakResult.text.startsWith('Brak szczytów')) {
            sections.push(peakResult.text);
          }
        }
        peakText = sections.join('\n\n');
      }
    }

    this.throwIfAborted(signal);
    yield {
      event: 'status',
      data: { phase: 'prefetch', message: 'Sprawdzam szlaki…' },
    };
    const trailHits = await this.rag.searchByQuery(dto.message, {
      limit: this.prefetchLimit,
      sources: ['biblioteka-tras', 'szlaki-dlugodystansowe'],
    });
    usage.embeddingCalls += 1;
    this.rememberPrefetch(trailHits, sourceIds, resolvedSources);
    const prefetched = [...blogHits, ...trailHits];

    const looseRange = extractLooseRange(dto.message);
    const namedRange = extractMountainRange(dto.message) ?? looseRange?.phrase;
    const specificTarget = messageTargetsSpecificPlace(dto.message);
    const asksBeside = Boolean(namedRange) && messageAsksWhatIsBeside(dto.message);
    const askedPeak = asksBeside ? undefined : placeAskedAbout(dto.message);
    const wantsSuggestion = messageWantsRangeSuggestion(dto.message);
    const departureVoivodeship = mentionedVoivodeship(dto.message);
    const continueDeparture =
      !specificTarget &&
      departureVoivodeship !== undefined &&
      (messageGivesDeparturePlace(dto.message) || priorAskedForDeparture);
    let nearbyFallback: string | undefined;
    let focusFallback: string | undefined;
    let focusBlock = '';
    let suggestionBlock = '';
    if (asksBeside && (looseRange?.like || namedRange)) {
      this.throwIfAborted(signal);
      yield {
        event: 'status',
        data: { phase: 'prefetch', message: 'Sprawdzam, co leży obok tego pasma…' },
      };
      const beside = await this.tools.lookupRangesBeside(
        looseRange?.like ?? namedRange ?? '',
        looseRange?.preferPrefix,
        standingDeparture,
      );
      if (beside) {
        this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, beside);
        focusBlock = beside.text;
        focusFallback = beside.focusReply;
      }
    } else if (askedPeak) {
      this.throwIfAborted(signal);
      yield {
        event: 'status',
        data: { phase: 'prefetch', message: `Sprawdzam szczyt ${askedPeak}…` },
      };
      const focused = await this.tools.lookupPeakFocus(askedPeak, standingDeparture);
      if (focused) {
        this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, focused);
        peakText = focused.text;
        focusFallback = focused.focusReply;
      }
    }
    if (!focusFallback && namedRange && !asksBeside && rangePickPeaks && rangePickPeaks.length > 0) {
      focusFallback = formatRangePickReply(namedRange, rangePickPeaks, standingDeparture);
    }
    if (wantsSuggestion && !continueDeparture) {
      this.throwIfAborted(signal);
      const suggestionArgs: Record<string, unknown> = { limit: 3 };
      if (standingDeparture) {
        suggestionArgs.locality = standingDeparture.locality;
        suggestionArgs.voivodeship = standingDeparture.voivodeship;
      }
      yield {
        event: 'status',
        data: {
          phase: 'prefetch',
          message: standingDeparture
            ? `Szukam najbliższych pasm od ${standingDeparture.locality}…`
            : dto.location
              ? 'Szukam najbliższych pasm od Twojej pozycji…'
              : 'Ustalam, skąd liczyć wyjazd…',
        },
      };
      const suggestion = await this.tools.execute(
        'suggest_nearby_ranges',
        JSON.stringify(suggestionArgs),
        toolContext,
        signal,
      );
      this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, suggestion);
      nearbyFallback = suggestion.directReply;
      suggestionBlock = suggestion.text;
    }
    const asksForRoute = messageAsksForRoute(dto.message);
    const tripToRange = Boolean(namedRange) && messagePlansTrip(dto.message);
    const routeQuery = asksForRoute ? dto.message : namedRange;
    let libraryText = '';
    if ((asksForRoute || tripToRange) && routeQuery && routeQueryTokens(routeQuery).length > 0) {
      const routeResult = await this.tools.execute(
        'search_library_routes',
        JSON.stringify({ query: routeQuery, limit: 3 }),
        toolContext,
      );
      const libraryEmpty = routeResult.text.startsWith('W bibliotece tras nie ma planu');
      if (!libraryEmpty || asksForRoute) {
        this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, routeResult);
        libraryText = routeResult.text;
      }
    }

    const blogSection = blogHits.length
      ? this.formatPrefetch(blogHits)
      : 'Brak trafień w blogach.';
    const peakSection = peakText
      ? peakText
      : 'Katalog szczytów nie był pytany, bo wiadomość nie wskazuje pasma ani listy szczytów. Gdy potrzebna jest wysokość albo lista, wywołaj search_peaks — to krok 2, po blogu, a przed szlakami i internetem.';
    const trailParts = [
      trailHits.length ? this.formatPrefetch(trailHits) : 'Brak trafień w szlakach długodystansowych i bibliotece (wyszukiwanie treści).',
      libraryText ? `Biblioteka tras:\n${libraryText}` : '',
    ].filter((part) => part.length > 0);
    system +=
      '\n\nMateriały trailON są już sprawdzone w tej kolejności. Odpowiadaj od punktu 1 i schodź niżej tylko gdy wyższy punkt nie wystarcza. Internet (search_web) jest za punktem 3.' +
      `\n\n1. Blogi\n${blogSection}` +
      `\n\n2. Szczyty\n${peakSection}` +
      `\n\n3. Szlaki\n${trailParts.join('\n\n')}`;

    const siteMaterialsFound =
      blogHits.length > 0 || peakText.length > 0 || trailHits.length > 0 || libraryText.length > 0;

    if (messageAsksToShowOnMap(dto.message)) {
      system += peakText
        ? '\n\nTa wiadomość prosi o pokazanie na mapie. To temat górski. Nie używaj gadki przewodnika. Dla szczytu z sekcji 2, który jest na liście, wklej sam url mapy w osobnej linii, 1:1. Szczytu spoza listy nie linkuj — napisz, że nie ma go na liście.'
        : '\n\nTa wiadomość prosi o pokazanie na mapie, a w katalogu nie ma pasującego szczytu. To nadal temat górski. Nie używaj gadki przewodnika. Napisz wprost, że nie pokażesz tego na mapie, bo nie ma tego na liście szczytów trailON.';
    }

    if (namedRange && !asksBeside) {
      system +=
        `\n\nTa wiadomość dotyczy pasma ${namedRange}. To temat górski, także gdy użytkownik pisze tylko o wyjeździe i nie używa słowa „góry”. ` +
        'Nie używaj gadki o sprawach spoza gór. Odpowiedz najpierw z blogów, potem ze szczytów (nazwa i wysokość), a plan trasy ze szlaków. ' +
        'Nie wywołuj suggest_nearby_ranges i nie powtarzaj listy najbliższych pasm od punktu startu. Dopytaj wyłącznie o brakujący konkret do trasy.';
    }

    if (specificTarget) {
      system +=
        '\n\nBieżące pytanie nie jest prośbą o listę najbliższych pasm. Nie wywołuj suggest_nearby_ranges. ' +
        'Nie zaczynaj od „Liczę od” i nie wklejaj poprzedniej listy, nawet jeśli tak wyglądała ostatnia odpowiedź. ' +
        'Odpowiedz na to, o co użytkownik pyta teraz.';
    }

    if (focusBlock) {
      system += `\n\nOkolica pasma — odpowiedz na tej podstawie, własnymi słowami:\n${focusBlock}`;
    }

    if (suggestionBlock) {
      system +=
        '\n\nPropozycja wyjazdu — ta wiadomość pyta, dokąd jechać w góry, i nie nazywa pasma. ' +
        'Nie używaj gadki spoza gór. Nie wymieniaj pasm z sekcji 1–3 ani z pamięci. Odpowiedź bierz wyłącznie stąd:\n' +
        suggestionBlock;
    } else if (continueDeparture) {
      system +=
        `\n\nUżytkownik podał województwo (${departureVoivodeship}) jako miejsce, skąd jedzie. To ciąg tematu górskiego. ` +
        'Wywołaj suggest_nearby_ranges z locality i voivodeship z tej wiadomości. Nie wymieniaj pasm, zanim narzędzie nie zwróci odległości. Nie używaj gadki spoza gór.';
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
    let webUnlocked = !siteMaterialsFound;

    while (round <= this.maxToolRounds) {
      this.throwIfAborted(signal);
      let sawTools = false;
      let streamedText = false;
      let resultText: string | undefined;
      let resultToolCalls: ChatMessage['tool_calls'] = [];
      let resultModel = latestModel;
      for await (const event of this.openAi.completeStream(messages, {
        tools: GUIDE_TOOLS,
        toolChoice:
          round === 0 && continueDeparture
            ? { type: 'function', function: { name: 'suggest_nearby_ranges' } }
            : 'auto',
        maxCompletionTokens: this.maxCompletionTokens,
        temperature: 0.3,
        signal,
      })) {
        this.throwIfAborted(signal);
        if (event.kind === 'tools') {
          sawTools = true;
          if (streamedText) {
            yield { event: 'clear', data: {} };
            streamedText = false;
          }
          continue;
        }
        if (event.kind === 'text') {
          if (!sawTools && event.text) {
            yield { event: 'delta', data: { text: event.text } };
            streamedText = true;
          }
          continue;
        }
        resultText = event.result.text;
        resultToolCalls = event.result.toolCalls ?? [];
        resultModel = event.result.model;
        usage.completionCalls += 1;
        this.mergeUsage(usage, event.result.usage);
        latestModel = resultModel;
      }

      if (resultToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: resultText ?? '',
          tool_calls: resultToolCalls,
        });
        let deferredWeb = false;
        for (const call of resultToolCalls) {
          this.throwIfAborted(signal);
          const deferWeb = call.name === 'search_web' && !webUnlocked;
          yield {
            event: 'status',
            data: {
              phase: 'tool',
              name: call.name,
              message: deferWeb ? 'Zostaję przy materiałach trailON…' : toolStatusMessage(call.name),
            },
          };
          const toolResult = deferWeb
            ? { text: WEB_DEFER_TEXT, sourceKeys: [] }
            : await this.tools.execute(call.name, call.arguments, toolContext, signal);
          if (deferWeb) {
            deferredWeb = true;
          } else {
            this.mergeUsage(usage, toolResult.usage);
            if (call.name === 'search_materials') {
              usage.embeddingCalls += toolResult.embeddingCalls ?? 1;
            }
            if (call.name === 'search_peaks') {
              usage.embeddingCalls += toolResult.embeddingCalls ?? 0;
            }
          }
          this.absorbToolResult(sourceIds, resolvedSources, knownPeaks, toolResult);
          if (
            call.name === 'suggest_nearby_ranges' &&
            toolResult.directReply &&
            messageAllowsNearbyList(dto.message, priorAskedForDeparture)
          ) {
            nearbyFallback = toolResult.directReply;
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult.text,
          });
        }
        if (deferredWeb) {
          webUnlocked = true;
        }
        round += 1;
        continue;
      }

      finalText = resultText?.trim() ?? '';
      break;
    }

    const priorUserTexts = priorTurns
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.content);
    const staysOnMountains = messageStaysOnMountains(dto.message, priorUserTexts);
    const repeatedNearbyList = isNearbyRangesTemplate(finalText);
    if (specificTarget && focusFallback && (!finalText || isOffTopicGuideReply(finalText) || repeatedNearbyList)) {
      finalText = focusFallback;
    } else if (!finalText) {
      finalText =
        nearbyFallback ??
        'Nie udało się przygotować odpowiedzi. Spróbuj przeformułować pytanie lub zawęzić temat.';
    } else if (
      !specificTarget &&
      nearbyFallback &&
      (isOffTopicGuideReply(finalText) || dropsSuggestedRanges(finalText, nearbyFallback))
    ) {
      finalText = nearbyFallback;
    } else if (isOffTopicGuideReply(finalText) && staysOnMountains) {
      const corpus = [...priorTurns.map((turn) => turn.content), dto.message, finalText].join('\n');
      const mapPeaks = messageAsksToShowOnMap(dto.message)
        ? peaksForMapReply(knownPeaks, corpus)
        : [];
      const mapReply = formatCatalogPeakMapReply(mapPeaks);
      if (mapReply) {
        finalText = mapReply;
      } else if (messageAsksToShowOnMap(dto.message)) {
        finalText = MAP_UNKNOWN_REPLY;
      } else {
        finalText = MOUNTAIN_UNKNOWN_REPLY;
      }
    }

    const sources = this.omitRepeatedBlogSources(
      this.buildSources([...sourceIds], prefetched, resolvedSources),
      alreadyCitedBlogs,
    );
    finalText = annotatePeakElevations(finalText, [
      ...knownPeaks,
      ...this.rag.peakElevationsMentionedIn(finalText),
    ]);
    finalText = annotatePeakMapLinks(finalText, knownPeaks);
    finalText = stripMismatchedPeakBlogUrls(finalText, peakBlogBindings(sources));
    finalText = suppressRepeatedBlogLinks(finalText, alreadyCitedBlogs);
    finalText = stripTrailingOffer(finalText);

    await this.conversationHistory.appendExchange(
      conversationId,
      dto.message,
      finalText,
      questionAt,
    );

    yield {
      event: 'done',
      data: {
        conversationId,
        response: this.formatHtmlResponse(finalText, sources, knownPeaks),
        model: latestModel,
        sources,
        usage,
      },
    };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
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

  private formatHtmlResponse(
    text: string,
    sources: GuideSource[],
    peaks: readonly GuidePeakElevation[],
  ): string {
    const cleaned = this.stripTrailingSourcesSection(text).trim();
    const urlTitles = buildUrlTitleMap(sources);
    for (const peak of peaks) {
      const id = peak.id?.trim();
      const name = peak.name.trim();
      if (!id || !name) {
        continue;
      }
      urlTitles.set(normalizeTrailonUrl(peakMapUrl(id)), name);
    }
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
    knownPeaks: GuidePeakElevation[],
    toolResult: { sourceKeys: string[]; sources?: GuideSource[]; peaks?: GuidePeakElevation[]; embeddingCalls?: number },
  ): void {
    for (const key of toolResult.sourceKeys) {
      sourceIds.add(key);
    }
    for (const peak of toolResult.peaks ?? []) {
      knownPeaks.push(peak);
    }
    for (const source of toolResult.sources ?? []) {
      const mapKey = isPeakSourceLabel(source.source) ? `peak:${source.id}` : source.id;
      this.rememberSource(resolvedSources, source, mapKey);
    }
  }

  private rememberPrefetch(
    hits: RagSearchHit[],
    sourceIds: Set<string>,
    resolvedSources: Map<string, GuideSource>,
  ): void {
    for (const hit of hits) {
      sourceIds.add(hit.id);
      this.rememberSource(resolvedSources, {
        id: hit.id,
        title: hit.title,
        source: RAG_SOURCE_LOCATIONS[hit.source],
        url: hit.url,
      });
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