import pino from 'pino';
import type { AiProvider, GenerateRequest, GenerateResponse } from '../types.js';

const logger = pino({ name: 'ai-gateway:anthropic' });

const DEFAULT_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5-20250929';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic-api';
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('ANTHROPIC_API_KEY not set — AnthropicProvider will fail on generate calls');
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    const model = DEFAULT_MODEL;
    const maxTokens = req.maxTokens || 8192;

    const startTime = Date.now();
    logger.info({ promptLength: req.userPrompt.length, model, hasSchema: !!req.jsonSchema }, 'Starting Anthropic API call');

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody }, 'Anthropic API call failed');
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const inputTokens = data.usage.input_tokens;
    const outputTokens = data.usage.output_tokens;
    const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    const elapsed = Date.now() - startTime;
    logger.info({ model: data.model, inputTokens, outputTokens, costUsd, elapsed }, 'Anthropic API call complete');

    return {
      content,
      model: data.model,
      inputTokens,
      outputTokens,
      costUsd,
    };
  }
}
