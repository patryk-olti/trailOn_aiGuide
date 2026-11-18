import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { D1Service } from '../cloudflare/d1.service';
import { PeakRow } from '../cloudflare/d1.types';
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
    private readonly d1: D1Service,
    private readonly openAi: OpenAiService,
  ) {
    this.indexKey = this.config.getOrThrow<string>('RAG_INDEX_KEY');
    this.dimensions = this.config.getOrThrow<number>('RAG_EMBEDDING_DIMENSIONS');
    this.embeddingModel = this.config.getOrThrow<string>('OPENAI_EMBEDDING_MODEL');
  }

  async buildIndex(): Promise<RagIndexBuildResult> {
    await this.syncPeaksToR2();
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
      .filter((object) => object.key.endsWith('.json'))
      .filter((object) => {
        const last = object.key.split('/').filter(Boolean).pop() ?? '';
        return !last.startsWith('_');
      });

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

  private async syncPeaksToR2(): Promise<void> {
    const table = this.d1.assertTableName(this.d1.peaksTable);
    let peaks: PeakRow[] = [];
    try {
      peaks = await this.d1.query<PeakRow>(
        `SELECT peak_id, name, elevation_m, range_name, lat, lng, tags_json, description, status, recommended
         FROM ${table}
         WHERE status = 'published'`,
      );
    } catch (error) {
      // Indeks materiałów z R2 ma działać nawet jeśli D1 jest niedostępne.
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Pominięto synchronizację szczytów z D1: ${message}`);
      return;
    }

    const manifestKey = 'szczyty/_manifest.json';
    type Manifest = { version: 1; updatedAt: string; hashes: Record<string, string> };
    let manifest: Manifest = { version: 1, updatedAt: new Date().toISOString(), hashes: {} };
    try {
      const existing = await this.r2.getText(manifestKey);
      const parsed = JSON.parse(existing.text) as Manifest;
      if (parsed && parsed.version === 1 && parsed.hashes && typeof parsed.hashes === 'object') {
        manifest = parsed;
      }
    } catch {
      // brak manifestu - ok
    }

    const desired = new Map<string, { json: string; hash: string }>();
    for (const row of peaks) {
      if (!row?.peak_id) {
        continue;
      }
      const key = `szczyty/${row.peak_id}.json`;
      const url = blogUrlFromTags(row.tags_json);
      const payload = {
        peak_id: row.peak_id,
        name: row.name,
        elevation_m: row.elevation_m,
        range_name: row.range_name,
        lat: row.lat,
        lng: row.lng,
        tags_json: row.tags_json,
        description: row.description,
        status: row.status,
        recommended: row.recommended,
        url,
      };
      const json = `${JSON.stringify(payload)}\n`;
      const hash = sha256(json);
      desired.set(key, { json, hash });
    }

    let updated = 0;
    let deleted = 0;

    for (const [key, entry] of desired.entries()) {
      if (manifest.hashes[key] === entry.hash) {
        continue;
      }
      await this.r2.putText(key, entry.json);
      manifest.hashes[key] = entry.hash;
      updated += 1;
    }

    const desiredKeys = new Set(desired.keys());
    for (const existingKey of Object.keys(manifest.hashes)) {
      if (!existingKey.startsWith('szczyty/') || existingKey === manifestKey) {
        continue;
      }
      if (desiredKeys.has(existingKey)) {
        continue;
      }
      await this.r2.deleteObject(existingKey);
      delete manifest.hashes[existingKey];
      deleted += 1;
    }

    manifest.updatedAt = new Date().toISOString();
    await this.r2.putText(manifestKey, `${JSON.stringify(manifest)}\n`);

    if (updated > 0 || deleted > 0) {
      this.logger.log(`Zsynchronizowano szczyty z D1 → R2: zapisano ${updated}, usunięto ${deleted}.`);
    }
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

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function blogUrlFromTags(tagsJson: string | null | undefined): string | undefined {
  if (!tagsJson?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const value = record.url ?? record.blog_url ?? record.blogUrl;
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}