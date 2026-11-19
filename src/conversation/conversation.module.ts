import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { ConversationHistoryController } from './conversation-history.controller';
import { ConversationHistoryService } from './conversation-history.service';

@Module({
  imports: [CloudflareModule],
  controllers: [ConversationHistoryController],
  providers: [ConversationHistoryService],
  exports: [ConversationHistoryService],
})
export class ConversationModule {}