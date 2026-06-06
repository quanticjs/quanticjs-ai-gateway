import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createCircuitBreaker } from '@quanticjs/core';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import type { AiProvider, AiGenerateRequest, AiGenerateResponse } from './ai-provider.interface';
import { GenerateMetrics } from '../generate.metrics';

const BREAKER_STATE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

@Injectable()
export class SdkProvider implements AiProvider {
  readonly name = 'claude-sdk';

  private readonly defaultModel: string;
  private readonly home: string;
  private readonly credentialsSrc: string;
  private readonly credentialsPath: string;
  private readonly oauthClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  private readonly breaker;

  constructor(
    private readonly config: ConfigService,
    @InjectPinoLogger(SdkProvider.name) private readonly logger: PinoLogger,
    private readonly metrics: GenerateMetrics,
  ) {
    this.defaultModel = this.config.get('AI_MODEL', 'claude-sonnet-4-5-20250929');
    this.home = process.env.HOME || '/home/node';
    this.credentialsSrc = join(this.home, '.claude', 'credentials.json');
    this.credentialsPath = join(this.home, '.claude', '.credentials.json');

    this.breaker = createCircuitBreaker({
      maxRetries: 2,
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      onStateChange: (state) =>
        this.metrics.circuitBreakerState.set({ provider: 'claude-sdk' }, BREAKER_STATE[state] ?? 0),
    });

    this.ensureCredentials().catch(() => {});
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return this.breaker.execute(() => this.callSdk(request));
  }

  private async callSdk(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    await this.ensureCredentials();

    const model = request.model ?? this.defaultModel;
    const startTime = Date.now();

    this.logger.info(
      { promptLength: request.userPrompt.length, model, hasSchema: !!request.jsonSchema },
      'Starting SDK generation',
    );

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      this.logger.warn({ elapsed: Date.now() - startTime }, 'SDK generation timed out');
      abortController.abort();
    }, 30 * 60 * 1000);

    const options: Parameters<typeof query>[0]['options'] = {
      systemPrompt: request.systemPrompt,
      model,
      tools: [],
      maxTurns: 50,
      persistSession: false,
      settingSources: [],
      permissionMode: 'dontAsk' as any,
      abortController,
    };

    if (request.jsonSchema) {
      options.outputFormat = {
        type: 'json_schema' as const,
        schema: request.jsonSchema,
      };
    }

    let content = '';
    let resultModel = 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;

    for await (const message of query({ prompt: request.userPrompt, options })) {
      if (message.type !== 'result') {
        const msg = message as any;
        if (msg.error === 'authentication_failed') {
          clearTimeout(timeout);
          this.logger.error({ error: msg.error }, 'Auth failed — aborting');
          throw new Error('Authentication failed — OAuth token expired or invalid');
        }
        if (msg.error) {
          const errorText = msg.message?.content?.[0]?.text || '';
          const is4xx = /API Error: 4\d\d/.test(errorText);
          if (is4xx) {
            clearTimeout(timeout);
            this.logger.error({ error: msg.error, content: errorText.substring(0, 300) }, 'Client error (4xx)');
            throw new Error(`Non-retryable error: ${errorText.substring(0, 200)}`);
          }
          this.logger.warn({ type: msg.type, error: msg.error }, 'SDK turn error');
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          content = request.jsonSchema && message.structured_output
            ? JSON.stringify(message.structured_output)
            : message.result;
        } else {
          const errors = 'errors' in message ? (message as any).errors : [];
          this.logger.error({ subtype: message.subtype, errors }, 'Claude SDK error');
          throw new Error(`Claude returned error: ${message.subtype} — ${errors?.join(', ') ?? 'unknown'}`);
        }

        costUsd = message.total_cost_usd ?? 0;

        for (const [modelName, usage] of Object.entries(message.modelUsage)) {
          resultModel = modelName;
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
        }
      }
    }

    clearTimeout(timeout);
    const durationMs = Date.now() - startTime;

    this.logger.info({ model: resultModel, inputTokens, outputTokens, costUsd, durationMs }, 'SDK generation complete');

    return { content, model: resultModel, inputTokens, outputTokens, costUsd, durationMs };
  }

  private async ensureCredentials(): Promise<void> {
    const envToken = this.config.get('CLAUDE_CODE_OAUTH_TOKEN');

    if (envToken) {
      const creds = {
        claudeAiOauth: {
          accessToken: envToken,
          refreshToken: '',
          expiresAt: 4102444800000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      };
      const json = JSON.stringify(creds);
      try {
        writeFileSync(this.credentialsPath, json, { mode: 0o600 });
        writeFileSync(this.credentialsSrc, json, { mode: 0o600 });
      } catch { /* may not have permission */ }
      return;
    }

    if (existsSync(this.credentialsSrc)) {
      copyFileSync(this.credentialsSrc, this.credentialsPath);
      try { chmodSync(this.credentialsPath, 0o600); } catch {}
    }

    if (!existsSync(this.credentialsPath)) return;

    try {
      const raw = readFileSync(this.credentialsPath, 'utf-8');
      const creds = JSON.parse(raw);
      const oauth = creds?.claudeAiOauth;
      if (!oauth?.expiresAt || !oauth?.refreshToken) return;

      const fiveMinutes = 5 * 60 * 1000;
      if (Date.now() < oauth.expiresAt - fiveMinutes) return;

      this.logger.info('OAuth token expired or expiring — refreshing');

      const resp = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'claude-code/1.0',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: this.oauthClientId,
        }).toString(),
      });

      if (!resp.ok) {
        const body = await resp.text();
        this.logger.error({ status: resp.status, body: body.substring(0, 300) }, 'OAuth refresh failed');
        return;
      }

      const tokens = (await resp.json()) as Record<string, any>;
      this.logger.info('OAuth token refreshed');

      oauth.accessToken = tokens.access_token;
      oauth.refreshToken = tokens.refresh_token ?? oauth.refreshToken;
      oauth.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

      const updated = JSON.stringify(creds, null, 2);
      writeFileSync(this.credentialsPath, updated, { mode: 0o600 });
      writeFileSync(this.credentialsSrc, updated, { mode: 0o600 });
    } catch (err) {
      this.logger.error({ err }, 'Failed to check/refresh credentials');
    }
  }
}
