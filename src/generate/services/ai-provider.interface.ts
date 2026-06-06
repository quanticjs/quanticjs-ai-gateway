export interface AiGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  model?: string;
  jsonSchema?: Record<string, unknown>;
}

export interface AiGenerateResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface AiProvider {
  readonly name: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
