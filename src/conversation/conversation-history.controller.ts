import { Controller, Get, Param } from '@nestjs/common';
import { ConversationHistoryService } from './conversation-history.service';
import { ParticipantHistory } from './conversation.types';

@Controller('guide')
export class ConversationHistoryController {
  constructor(private readonly history: ConversationHistoryService) {}

  @Get('history/:participantId')
  getHistory(@Param('participantId') participantId: string): Promise<ParticipantHistory> {
    return this.history.getHistoryForParticipant(participantId);
  }
}
