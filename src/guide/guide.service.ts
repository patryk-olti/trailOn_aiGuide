import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D1Service } from '../cloudflare/d1.service';
import { OpenAiService } from '../openai/openai.service';
import { ChatMessage, TokenUsage } from '../openai/openai.types';
import { RagIndexService } from '../rag/rag-index.service';
import { RagSearchHit } from '../rag/rag.types';
import { CreateGuideDto } from './dto/create-guide.dto';
import { GUIDE_TOOLS, GuideToolsExecutor } from './guide.tools';
import { LOCATION_REQUIRED_USER_HINT, messageImpliesProximity } from './guide-location.messages';
import { GuideReply, GuideSource, GuideToolRequestContext, GuideUsage } from './guide.types';

const SYSTEM_PROMPT = `Jesteś przewodnikiem AI TrailOn. Pomagasz układać trasy i korzystasz z materiałów zespołu trailON (blog, biblioteka tras, szlaki długodystansowe) oraz katalogu szczytów.
Odpowiadaj po polsku, konkretnie i praktycznie. Uwzględniaj bezpieczeństwo i realia terenu.
Jeśli materiały nie zawierają odpowiedzi, powiedz to wprost. Nie wymyślaj faktów. Na końcu podaj krótką sekcję "Źródła" z tytułami i linkami, gdy są dostępne.`;

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
    d1: D1Service,
    config: ConfigService,
  ) {
    this.maxToolRounds = config.getOrThrow<number>('RAG_TOOL_ROUND_LIMIT');
    this.maxCompletionTokens = config.getOrThrow<number>('RAG_MAX_COMPLETION_TOKENS');
    this.prefetchLimit = config.getOrThrow<number>('RAG_PREFETCH_LIMIT');
    this.defaultModel = config.getOrThrow<string>('OPENAI_MODEL');
    this.tools = new GuideToolsExecutor(rag, d1);
  }

  async reply(dto: CreateGuideDto): Promise<GuideReply> {
    const usage: GuideUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      completionCalls: 0,
      embeddingCalls: 1,
    };
    const sourceIds = new Set<string>();
    const prefetched = await this.rag.searchByQuery(dto.message, { limit: this.prefetchLimit });

    let system = SYSTEM_PROMPT;
    if (dto.context?.trim()) {
      system += `\n\nDodatkowy kontekst użytkownika:\n${dto.context.trim()}`;
    }
    const proximityWithoutLocation = !dto.location && messageImpliesProximity(dto.message);
    if (dto.location) {
      const radiusKm = dto.location.radiusKm ?? 100;
      system +=
        `\n\nPozycja użytkownika (GPS): szerokość ${dto.location.lat}, długość ${dto.location.lng}, domyślny promień szczytów ${radiusKm} km.` +
        ' Przy pytaniach o szczyty w pobliżu wywołaj search_peaks z minElevationM i ewentualnie radiusKm; nearLat/nearLng możesz pominąć — użyjemy współrzędnych z żądania.';
    } else {
      system +=
        '\n\nW żądaniu brak pola location (GPS) — wyszukiwanie szczytów po odległości/promieniu jest wyłączone.';
      if (proximityWithoutLocation) {
        system += ` Użytkownik pyta o coś w pobliżu: nie podawaj list szczytów „najbliższych” ani odległości. Wyjaśnij po polsku: ${LOCATION_REQUIRED_USER_HINT}`;
      } else {
        system +=
          ' Gdy pytanie dotyczy „w pobliżu”, promienia lub odległości w km, poproś o włączenie lokalizacji zamiast zgadywać pozycję.';
      }
    }
    const contextBlock = this.formatPrefetch(prefetched);
    if (contextBlock) {
      system += `\n\nNajbardziej pasujące materiały:\n${contextBlock}`;
      for (const hit of prefetched) {
        sourceIds.add(hit.id);
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: dto.message },
    ];

    let latestModel = this.defaultModel;
    let finalText = '';
    let round = 0;
    const toolContext: GuideToolRequestContext = {
      locationMissingForProximity: proximityWithoutLocation,
      ...(dto.location
        ? {
            location: {
              lat: dto.location.lat,
              lng: dto.location.lng,
              radiusKm: dto.location.radiusKm,
            },
          }
        : {}),
    };

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
          for (const key of toolResult.sourceKeys) {
            sourceIds.add(key);
          }
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

    return {
      reply: finalText,
      model: latestModel,
      sources: this.buildSources([...sourceIds], prefetched),
      usage,
    };
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

  private buildSources(ids: string[], prefetched: RagSearchHit[]): GuideSource[] {
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
        out.push({
          id: peakId,
          title: `Szczyt ${peakId}`,
          source: 'szczyty',
        });
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
        source: hit.source,
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