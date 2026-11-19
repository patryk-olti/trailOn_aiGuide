import { Controller, Delete, Get, Param } from '@nestjs/common';
import { ConversationHistoryService } from './conversation-history.service';
import { ParticipantHistory } from './conversation.types';

@Controller('guide')
export class ConversationHistoryController {
  constructor(private readonly history: ConversationHistoryService) {}

  @Get('history/:participantId')
  getHistory(@Param('participantId') participantId: string): Promise<ParticipantHistory> {
    return this.history.getHistoryForParticipant(participantId);
  }

  @Delete('history/:participantId/:conversationId')
  deleteHistory(
    @Param('participantId') participantId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<{ deleted: true }> {
    return this.history.deleteConversation(participantId, conversationId);
  }
}
