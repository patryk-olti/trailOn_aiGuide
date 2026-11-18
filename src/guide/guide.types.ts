export interface GuideToolRequestContext {
  location?: {
    lat: number;
    lng: number;
    radiusKm?: number;
  };
  /** Pytanie dotyczy odległości, a w body brak location — search_peaks nie może liczyć promienia. */
  locationMissingForProximity?: boolean;
}

export interface GuideSource {
  id: string;
  title: string;
  source: string;
  url?: string;
}

export interface GuideToolResult {
  text: string;
  sourceKeys: string[];
  sources?: GuideSource[];
  embeddingCalls?: number;
}

export interface GuideUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  completionCalls: number;
  embeddingCalls: number;
}

export interface GuideReply {
  reply: string;
  model: string;
  sources: GuideSource[];
  usage: GuideUsage;
}