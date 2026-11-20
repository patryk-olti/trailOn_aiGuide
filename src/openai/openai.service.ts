import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ChatMessage,
  CompletionOptions,
  CompletionStreamEvent,
  EmbedOptions,
  TokenUsage,
  ToolCall,
} from './openai.types';

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly embeddingModel: string;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: this.config.getOrThrow<number>('OPENAI_TIMEOUT_MS'),
    });
    this.model = this.config.getOrThrow<string>('OPENAI_MODEL');
    this.embeddingModel = this.config.getOrThrow<string>('OPENAI_EMBEDDING_MODEL');
  }

  async *completeStream(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncGenerator<CompletionStreamEvent> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: this.toApiMessages(messages),
          tools: options?.tools,
          tool_choice: options?.toolChoice,
          max_completion_tokens: options?.maxCompletionTokens,
          temperature: options?.temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );

      let text = '';
      let model = this.model;
      let finishReason: string | undefined;
      let usage: TokenUsage | undefined;
      let announcedTools = false;
      const toolCalls = new Map<number, ToolCall>();

      for await (const chunk of stream) {
        if (chunk.model) {
          model = chunk.model;
        }
        if (chunk.usage) {
          usage = this.readUsage(chunk.usage);
        }
        const choice = chunk.choices[0];
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
        const content = delta?.content;
        if (content) {
          text += content;
          yield { kind: 'text', text: content };
        }
        for (const call of delta?.tool_calls ?? []) {
          this.accumulateToolCall(toolCalls, call);
          if (!announcedTools) {
            announcedTools = true;
            yield { kind: 'tools' };
          }
        }
      }

      const calls = [...toolCalls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map((entry) => entry[1])
        .filter((call) => call.name.length > 0);
      const trimmed = text.trim();
      if (!trimmed && calls.length === 0) {
        throw new ServiceUnavailableException('OpenAI returned an empty response');
      }
      yield {
        kind: 'result',
        result: {
          text: trimmed || undefined,
          model,
          toolCalls: calls,
          usage,
          finishReason,
        },
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof BadGatewayException
      ) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : 'Unknown OpenAI error';
      this.logger.error(detail);
      throw new BadGatewayException('OpenAI request failed');
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const dimensions =
      options?.dimensions ?? this.config.getOrThrow<number>('RAG_EMBEDDING_DIMENSIONS');
    try {
      const response = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: texts,
        dimensions,
      });
      return response.data
        .sort((left, right) => left.index - right.index)
        .map((row) => row.embedding);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown OpenAI error';
      this.logger.error(detail);
      throw new BadGatewayException('OpenAI embedding request failed');
    }
  }

  private toApiMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call_id ?? '',
        };
      }
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        };
      }
      return {
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      };
    });
  }

  private accumulateToolCall(
    toolCalls: Map<number, ToolCall>,
    call: { index: number; id?: string; function?: { name?: string; arguments?: string } },
  ): void {
    const current = toolCalls.get(call.index) ?? { id: '', name: '', arguments: '' };
    if (call.id) {
      current.id = call.id;
    }
    if (call.function?.name) {
      current.name += call.function.name;
    }
    if (call.function?.arguments) {
      current.arguments += call.function.arguments;
    }
    toolCalls.set(call.index, current);
  }

  private readUsage(
    usage: OpenAI.Completions.CompletionUsage | undefined,
  ): TokenUsage | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(error.name);
}