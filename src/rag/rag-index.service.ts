import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { R2Service } from '../cloudflare/r2.service';
import { OpenAiService } from '../openai/openai.service';
import { BlogPostRef, normalizePeakName, peakNamesForBlogEntry } from './rag-blog-lookup';
import { RAG_INDEX_REFRESH_MS, RagContentSource } from './rag.constants';
import { RagIndexEntry, RagIndexFile, RagMaterialDetail, RagSearchHit } from './rag.types';

type LoadedEntry = RagIndexEntry & {
  vector: Float32Array;
};

@Injectable()
export class RagIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagIndexService.name);
  private readonly indexKey: string;
  private readonly minScore: number;
  private readonly defaultLimit: number;
  private readonly dimensions: number;

  private entries: LoadedEntry[] = [];
  private blogByPeakName = new Map<string, BlogPostRef>();
  private loaded = false;
  private currentEtag: string | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly r2: R2Service,
    private readonly openAi: OpenAiService,
  ) {
    this.indexKey = this.config.getOrThrow<string>('RAG_INDEX_KEY');
    this.minScore = this.config.getOrThrow<number>('RAG_MIN_SCORE');
    this.defaultLimit = this.config.getOrThrow<number>('RAG_PREFETCH_LIMIT');
    this.dimensions = this.config.getOrThrow<number>('RAG_EMBEDDING_DIMENSIONS');
  }

  async onModuleInit(): Promise<void> {
    await this.reloadIndex();
    this.refreshTimer = setInterval(() => {
      void this.maybeReloadIndex();
    }, RAG_INDEX_REFRESH_MS);
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  isReady(): boolean {
    return this.loaded && this.entries.length > 0;
  }

  async searchByQuery(
    query: string,
    options?: {
      source?: RagContentSource;
      sources?: RagContentSource[];
      limit?: number;
      minScore?: number;
    },
  ): Promise<RagSearchHit[]> {
    if (!this.loaded || this.entries.length === 0) {
      return [];
    }
    const embeddings = await this.openAi.embed([query]);
    const vector = embeddings[0];
    if (!vector) {
      return [];
    }
    return this.searchByVector(vector, options);
  }

  searchByVector(
    vector: number[],
    options?: {
      source?: RagContentSource;
      sources?: RagContentSource[];
      limit?: number;
      minScore?: number;
    },
  ): RagSearchHit[] {
    if (!this.loaded || this.entries.length === 0) {
      return [];
    }
    const queryVector = this.normalize(vector);
    const limit = options?.limit ?? this.defaultLimit;
    const minScore = options?.minScore ?? this.minScore;
    const source = options?.source;
    const sources = Array.isArray(options?.sources) ? options?.sources : undefined;
    const sourceFilter =
      source ??
      (sources && sources.length > 0 ? sources : undefined);

    const hits = this.entries
      .filter((entry) => {
        if (!sourceFilter) {
          return true;
        }
        if (typeof sourceFilter === 'string') {
          return entry.source === sourceFilter;
        }
        return sourceFilter.includes(entry.source);
      })
      .map((entry) => ({
        id: entry.chunkId,
        source: entry.source,
        key: entry.key,
        title: entry.title,
        section: entry.section,
        url: entry.url,
        text: entry.text,
        score: this.dot(queryVector, entry.vector),
      }))
      .filter((hit) => hit.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return hits;
  }

  findBlogForPeakName(peakName: string): BlogPostRef | undefined {
    const key = normalizePeakName(peakName);
    if (key.length === 0) {
      return undefined;
    }
    return this.blogByPeakName.get(key);
  }

  getMaterial(id: string): RagMaterialDetail | undefined {
    const found = this.entries.find((entry) => entry.chunkId === id);
    if (!found) {
      return undefined;
    }
    const related = this.entries
      .filter((entry) => entry.key === found.key)
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
    const content = related.map((entry) => entry.text).join('\n\n').trim();
    return {
      id: found.chunkId,
      source: found.source,
      key: found.key,
      title: found.title,
      section: found.section,
      url: found.url,
      text: found.text,
      score: 1,
      content,
    };
  }

  private async maybeReloadIndex(): Promise<void> {
    const etag = await this.r2.headObject(this.indexKey);
    if (!etag || etag === this.currentEtag) {
      return;
    }
    await this.reloadIndex();
  }

  private async reloadIndex(): Promise<void> {
    try {
      const body = await this.r2.getText(this.indexKey);
      const file = JSON.parse(body.text) as RagIndexFile;
      if (file.version !== 1 || !Array.isArray(file.entries)) {
        throw new Error('Nieprawidłowy format pliku indeksu RAG.');
      }
      this.entries = file.entries
        .filter((entry) => Array.isArray(entry.embedding) && entry.embedding.length === this.dimensions)
        .map((entry) => ({
          ...entry,
          vector: this.normalize(entry.embedding),
        }));
      this.rebuildBlogPeakIndex();
      this.currentEtag = body.etag;
      this.loaded = true;
      this.logger.log(`Załadowano indeks RAG: ${this.entries.length} fragmentów.`);
    } catch (error) {
      this.loaded = true;
      this.entries = [];
      this.blogByPeakName.clear();
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Indeks RAG niedostępny (${this.indexKey}): ${message}`);
    }
  }

  private rebuildBlogPeakIndex(): void {
    this.blogByPeakName.clear();
    const firstChunkByKey = new Map<string, LoadedEntry>();
    for (const entry of this.entries) {
      if (entry.source !== 'blog') {
        continue;
      }
      const existing = firstChunkByKey.get(entry.key);
      if (!existing || entry.chunkId.localeCompare(existing.chunkId) < 0) {
        firstChunkByKey.set(entry.key, entry);
      }
    }
    for (const entry of firstChunkByKey.values()) {
      const names = peakNamesForBlogEntry(entry.key, entry.title);
      const primaryPeak = names[0] ?? entry.title;
      const ref: BlogPostRef = {
        key: entry.key,
        chunkId: entry.chunkId,
        title: entry.title,
        url: entry.url,
        peakName: primaryPeak,
      };
      for (const name of names) {
        this.blogByPeakName.set(normalizePeakName(name), ref);
      }
    }
  }

  private normalize(values: number[]): Float32Array {
    let sum = 0;
    for (const value of values) {
      sum += value * value;
    }
    const length = Math.sqrt(sum) || 1;
    const out = new Float32Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      out[index] = values[index] / length;
    }
    return out;
  }

  private dot(left: Float32Array, right: Float32Array): number {
    const size = Math.min(left.length, right.length);
    let sum = 0;
    for (let index = 0; index < size; index += 1) {
      sum += left[index] * right[index];
    }
    return sum;
  }
}