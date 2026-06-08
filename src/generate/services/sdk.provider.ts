import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import type { AiProvider, AiGenerateRequest, AiGenerateResponse } from './ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

@Injectable()
export class SdkProvider implements AiProvider {
  readonly name = 'claude-sdk';

  private readonly defaultModel: string;
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(SdkProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
  ) {
    this.defaultModel = this.config.get('AI_MODEL', 'claude-sonnet-4-5-20250929');

    this.breaker = createCircuitBreaker({
      maxRetries: 0,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'claude-sdk' }, BREAKER_STATE[state] ?? 0),
    });
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return this.breaker.execute(() => this.callSdk(request));
  }

  private async callSdk(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const model = request.model ?? this.defaultModel;
    const startTime = Date.now();

    this.logger.info(
      { promptLength: request.userPrompt.length, model, hasSchema: !!request.jsonSchema },
      'Starting SDK generation',
    );

    let userPrompt = request.userPrompt;
    if (request.jsonSchema) {
      userPrompt = `${request.userPrompt}\n\nYou MUST respond with ONLY valid JSON matching this schema (no markdown, no explanation, just the JSON object):\n${JSON.stringify(request.jsonSchema, null, 2)}`;
    }

    const conversation = query({
      prompt: userPrompt,
      options: {
        model,
        systemPrompt: request.systemPrompt,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      } as any,
    });

    let resultMessage: any = null;

    for await (const message of conversation) {
      if (message.type === 'result') {
        resultMessage = message;
      }
    }

    if (!resultMessage) {
      throw new Error('SDK query returned no result message');
    }

    if (resultMessage.subtype !== 'success') {
      const errors = resultMessage.errors?.join(', ') ?? 'unknown';
      throw new Error(`SDK generation failed (${resultMessage.subtype}): ${errors}`);
    }

    let content: string = resultMessage.result ?? '';

    if (request.jsonSchema && content) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) content = jsonMatch[0];
    }

    const usage = resultMessage.usage ?? { input_tokens: 0, output_tokens: 0 };
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const costUsd = resultMessage.total_cost_usd ?? 0;
    const durationMs = Date.now() - startTime;

    this.logger.info(
      { model, inputTokens, outputTokens, costUsd, durationMs, numTurns: resultMessage.num_turns, subtype: resultMessage.subtype, contentLength: content.length },
      'SDK generation complete',
    );

    return { content, model, inputTokens, outputTokens, costUsd, durationMs };
  }
}
