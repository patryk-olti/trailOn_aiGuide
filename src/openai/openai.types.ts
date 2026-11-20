import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionResult {
  text?: string;
  model: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  finishReason?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionOptions {
  tools?: ChatCompletionTool[];
  toolChoice?: 'auto' | 'none';
  maxCompletionTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type CompletionStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tools' }
  | { kind: 'result'; result: CompletionResult };

export interface EmbedOptions {
  dimensions?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
}

export interface WebSearchResult {
  text: string;
  hits: WebSearchHit[];
  usage?: TokenUsage;
}