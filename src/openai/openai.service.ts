import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ChatMessage, CompletionResult } from './openai.types';

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: this.config.getOrThrow<number>('OPENAI_TIMEOUT_MS'),
    });
    this.model = this.config.getOrThrow<string>('OPENAI_MODEL');
  }

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) {
        throw new ServiceUnavailableException('OpenAI returned an empty response');
      }
      return {
        text,
        model: completion.model,
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
}
