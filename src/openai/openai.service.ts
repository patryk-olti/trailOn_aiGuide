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
  CompletionResult,
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

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toApiMessages(messages),
        tools: options?.tools,
        tool_choice: options?.toolChoice,
        max_completion_tokens: options?.maxCompletionTokens,
        temperature: options?.temperature,
      });
      const choice = completion.choices[0];
      const message = choice?.message;
      const text = message?.content?.trim() || undefined;
      const toolCalls = this.readToolCalls(message?.tool_calls);
      if (!text && toolCalls.length === 0) {
        throw new ServiceUnavailableException('OpenAI returned an empty response');
      }
      return {
        text,
        model: completion.model,
        toolCalls,
        usage: this.readUsage(completion.usage),
        finishReason: choice?.finish_reason,
      };
    } catch (error) {
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

  private readToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessage['tool_calls'] | undefined,
  ): ToolCall[] {
    if (!toolCalls) {
      return [];
    }
    const out: ToolCall[] = [];
    for (const call of toolCalls) {
      if (call.type !== 'function') {
        continue;
      }
      out.push({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
    return out;
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