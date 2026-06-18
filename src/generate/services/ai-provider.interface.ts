export type AiMediaKind = 'document' | 'image';

/**
 * A reference to a file the model should read as multimodal input.
 * The gateway fetches `url` server-side and forwards the bytes to the model —
 * callers never send raw bytes/base64. `url` is typically a short-lived
 * presigned read URL from the File Service, reachable on the internal network.
 */
export interface AiMediaRef {
  url: string;
  kind: AiMediaKind;
  mediaType: string; // e.g. 'application/pdf', 'image/png'
  fileName?: string;
}

export interface AiGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  model?: string;
  jsonSchema?: Record<string, unknown>;
  media?: AiMediaRef[];
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
