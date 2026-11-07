import { Injectable } from '@nestjs/common';
import { OpenAiService } from '../openai/openai.service';
import { ChatMessage } from '../openai/openai.types';
import { CreateGuideDto } from './dto/create-guide.dto';
import { GuideReply } from './guide.types';

const SYSTEM_PROMPT =
  'Jesteś przewodnikiem AI TrailOn. Pomagasz w planowaniu i przebiegu szlaków. Odpowiadaj konkretnie, praktycznie i z uwzględnieniem bezpieczeństwa.';

@Injectable()
export class GuideService {
  constructor(private readonly openAi: OpenAiService) {}

  reply(dto: CreateGuideDto): Promise<GuideReply> {
    const system = dto.context
      ? `${SYSTEM_PROMPT}\n\nDodatkowy kontekst:\n${dto.context}`
      : SYSTEM_PROMPT;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: dto.message },
    ];

    return this.openAi.complete(messages).then((result) => ({
      reply: result.text,
      model: result.model,
    }));
  }
}
