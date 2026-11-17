import { Module } from '@nestjs/common';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { OpenAiModule } from '../openai/openai.module';
import { RagIndexService } from './rag-index.service';
import { RagIndexerService } from './rag-indexer.service';

@Module({
  imports: [CloudflareModule, OpenAiModule],
  providers: [RagIndexService, RagIndexerService],
  exports: [RagIndexService, RagIndexerService],
})
export class RagModule {}