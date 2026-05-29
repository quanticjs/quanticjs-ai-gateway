export interface GenerateRequest {
  requestId?: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}

export interface GenerateResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GenerateResult {
  requestId: string;
  status: 'success' | 'error';
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface AiProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}
