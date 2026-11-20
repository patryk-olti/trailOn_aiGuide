export interface GuideToolRequestContext {
  location?: {
    lat: number;
    lng: number;
    radiusKm?: number;
  };
}

export interface GuideSource {
  id: string;
  title: string;
  source: string;
  url?: string;
}

export interface GuidePeakElevation {
  name: string;
  elevationM: number;
}

export interface GuideToolResult {
  text: string;
  sourceKeys: string[];
  sources?: GuideSource[];
  peaks?: GuidePeakElevation[];
  embeddingCalls?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface GuideUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  completionCalls: number;
  embeddingCalls: number;
}

export interface GuideReply {
  conversationId: string;
  response: string;
  model: string;
  sources: GuideSource[];
  usage: GuideUsage;
}

/**
 * Strumień POST /guide (text/event-stream).
 * delta to surowy tekst modelu. clear czyści ten tekst, gdy runda poszła w narzędzia.
 * done.response to końcowy HTML — nim trzeba zastąpić złożone delty.
 */
export type GuideStreamEvent =
  | { event: 'meta'; data: { conversationId: string } }
  | { event: 'status'; data: { phase: 'prefetch' | 'tool'; name?: string; message: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'clear'; data: Record<string, never> }
  | { event: 'done'; data: GuideReply }
  | { event: 'error'; data: { message: string } };