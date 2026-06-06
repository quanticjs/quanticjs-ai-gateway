export class GenerateResponseDto {
  content!: string;
  model!: string;
  inputTokens!: number;
  outputTokens!: number;
  costUsd!: number;
  durationMs!: number;
}

export class AsyncGenerateResponseDto {
  requestId!: string;
}
