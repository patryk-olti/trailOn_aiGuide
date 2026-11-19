import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { ConversationHistoryService } from './conversation-history.service';

@Module({
  imports: [CloudflareModule],
  providers: [ConversationHistoryService],
  exports: [ConversationHistoryService],
})
export class ConversationModule {}