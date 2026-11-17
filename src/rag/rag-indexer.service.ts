import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { R2Service } from '../cloudflare/r2.service';
import { OpenAiService } from '../openai/openai.service';
import {
  RAG_CONTENT_PREFIXES,
  RAG_EMBED_BATCH_SIZE,
  RAG_INDEX_VERSION,
} from './rag.constants';
import { embeddingInputForChunk, parseR2JsonObject } from './rag-content';
import { RagChunkDraft, RagIndexEntry, RagIndexFile } from './rag.types';

export interface RagIndexBuildResult {
  entries: number;
  filesProcessed: number;
  filesReused: number;
  indexKey: string;
}

@Injectable()
export class RagIndexerService {
  private readonly logger = new Logger(RagIndexerService.name);
  private readonly indexKey: string;
  private readonly dimensions: number;
  private readonly embeddingModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly r2: R2Service,
    private readonly openAi: OpenAiService,
  ) {
    this.indexKey = this.config.getOrThrow<string>('RAG_INDEX_KEY');
    this.dimensions = this.config.getOrThrow<number>('RAG_EMBEDDING_DIMENSIONS');
    this.embeddingModel = this.config.getOrThrow<string>('OPENAI_EMBEDDING_MODEL');
  }

  async buildIndex(): Promise<RagIndexBuildResult> {
    const previous = await this.loadExistingIndex();
    const sourceEtags: Record<string, string> = { ...previous?.sourceEtags };
    const entriesByKey = new Map<string, RagIndexEntry[]>();

    if (previous) {
      for (const entry of previous.entries) {
        const bucket = entriesByKey.get(entry.key) ?? [];
        bucket.push(entry);
        entriesByKey.set(entry.key, bucket);
      }
    }

    let filesProcessed = 0;
    let filesReused = 0;
    const allKeys = (
      await Promise.all(RAG_CONTENT_PREFIXES.map((prefix) => this.r2.listObjects(prefix)))
    )
      .flat()
      .filter((object) => object.key.endsWith('.json'));

    for (const object of allKeys) {
      const etag = object.etag ?? '';
      if (etag && sourceEtags[object.key] === etag && entriesByKey.has(object.key)) {
        filesReused += 1;
        continue;
      }

      const body = await this.r2.getText(object.key);
      const drafts = parseR2JsonObject(object.key, body.text).filter((chunk) => chunk.text.length > 80);
      if (drafts.length === 0) {
        sourceEtags[object.key] = etag;
        entriesByKey.delete(object.key);
        continue;
      }

      const embedded = await this.embedDrafts(drafts);
      entriesByKey.set(object.key, embedded);
      sourceEtags[object.key] = etag || body.etag || '';
      filesProcessed += 1;
      this.logger.log(`Zindeksowano ${object.key} (${embedded.length} fragmentów).`);
    }

    const staleKeys = Object.keys(sourceEtags).filter(
      (key) => !allKeys.some((object) => object.key === key),
    );
    for (const staleKey of staleKeys) {
      delete sourceEtags[staleKey];
      entriesByKey.delete(staleKey);
    }

    const entries = [...entriesByKey.values()].flat();
    const file: RagIndexFile = {
      version: RAG_INDEX_VERSION,
      model: this.embeddingModel,
      dimensions: this.dimensions,
      builtAt: new Date().toISOString(),
      sourceEtags,
      entries,
    };

    await this.r2.putText(this.indexKey, `${JSON.stringify(file)}\n`);
    return {
      entries: entries.length,
      filesProcessed,
      filesReused,
      indexKey: this.indexKey,
    };
  }

  private async embedDrafts(drafts: RagChunkDraft[]): Promise<RagIndexEntry[]> {
    const result: RagIndexEntry[] = [];
    for (let start = 0; start < drafts.length; start += RAG_EMBED_BATCH_SIZE) {
      const batch = drafts.slice(start, start + RAG_EMBED_BATCH_SIZE);
      const inputs = batch.map((chunk) => embeddingInputForChunk(chunk));
      const vectors = await this.openAi.embed(inputs, { dimensions: this.dimensions });
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index];
        const embedding = vectors[index];
        if (!chunk || !embedding) {
          continue;
        }
        result.push({
          ...chunk,
          embedding,
        });
      }
    }
    return result;
  }

  private async loadExistingIndex(): Promise<RagIndexFile | undefined> {
    try {
      const body = await this.r2.getText(this.indexKey);
      const parsed = JSON.parse(body.text) as RagIndexFile;
      if (parsed.version !== RAG_INDEX_VERSION || !Array.isArray(parsed.entries)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }
}