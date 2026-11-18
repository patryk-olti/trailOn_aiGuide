import { RagContentSource } from './rag.constants';

export interface RagChunkDraft {
  source: RagContentSource;
  key: string;
  chunkId: string;
  title: string;
  section?: string;
  url?: string;
  peakName?: string;
  text: string;
}

export interface RagIndexEntry extends RagChunkDraft {
  embedding: number[];
}

export interface RagIndexFile {
  version: number;
  model: string;
  dimensions: number;
  builtAt: string;
  sourceEtags: Record<string, string>;
  entries: RagIndexEntry[];
}

export interface RagSearchHit {
  id: string;
  source: RagContentSource;
  key: string;
  title: string;
  section?: string;
  url?: string;
  text: string;
  score: number;
}

export interface RagMaterialDetail extends RagSearchHit {
  content: string;
}