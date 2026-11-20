export interface GuideToolRequestContext {
  location?: {
    lat: number;
    lng: number;
    radiusKm?: number;
  };
  /** Miejscowość i województwo podane wcześniej w tym wątku. Zostają, dopóki użytkownik nie wskaże innego miejsca. */
  departure?: {
    locality: string;
    voivodeship: string;
  };
  /** Bieżąca wiadomość. Narzędzie listy pasm nie traktuje nazwy szczytu jako nowego startu. */
  userMessage?: string;
  /** Asystent właśnie pytał o miejscowość. Sama nazwa miejscowości jest wtedy odpowiedzią, nie pytaniem o szczyt. */
  placeAnswerExpected?: boolean;
  /** Współrzędne wyliczone z departure w tym żądaniu, żeby nie geokodować drugi raz. */
  resolvedDeparture?: {
    lat: number;
    lng: number;
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
  /** Id z katalogu D1. Jest tylko wtedy, gdy szczyt jest na liście trailON. */
  id?: string;
}

export interface GuideToolResult {
  text: string;
  sourceKeys: string[];
  sources?: GuideSource[];
  peaks?: GuidePeakElevation[];
  /** Gotowa odpowiedź, gdy model wklei gadkę spoza gór zamiast propozycji pasm. */
  directReply?: string;
  /** Odpowiedź na konkretne pasmo albo szczyt, gdy model i tak wklei listę „Liczę od…”. */
  focusReply?: string;
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