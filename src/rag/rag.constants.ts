export const RAG_CONTENT_PREFIXES = [
  'blog/',
  'biblioteka-tras/',
  'szlaki-dlugodystansowe/',
  'szczyty/',
] as const;

export type RagContentSource = (typeof RAG_CONTENT_PREFIXES)[number] extends `${infer P}/`
  ? P
  : never;

export const RAG_CONTENT_SOURCES: RagContentSource[] = [
  'blog',
  'biblioteka-tras',
  'szlaki-dlugodystansowe',
  'szczyty',
];

/**
 * "Realne miejsce danych" do pokazywania w `GuideReply.sources[].source`.
 * Uwaga: to NIE jest filtr RAG — filtrujemy nadal po RagContentSource (blog/szczyty/...).
 */
export const RAG_SOURCE_LOCATIONS: Record<RagContentSource, string> = {
  szczyty: 'D1 Database -> peak -> trailon_peaks_blob',
  blog: 'R2 Object Storage -> trailonblog -> blog',
  'biblioteka-tras': 'R2 Object Storage -> trailonblog -> biblioteka-tras',
  'szlaki-dlugodystansowe': 'R2 Object Storage -> trailonblog -> szlaki-dlugodystansowe',
};

export const RAG_INDEX_VERSION = 1;

export const RAG_EMBED_BATCH_SIZE = 32;

export const RAG_MAX_CHUNK_CHARS = 1400;

export const RAG_MAX_TOOL_TEXT_CHARS = 1200;

export const RAG_INDEX_REFRESH_MS = 10 * 60 * 1000;