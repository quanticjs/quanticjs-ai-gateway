import { query } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import type { AiProvider, GenerateRequest, GenerateResponse } from '../types.js';

const logger = pino({ name: 'ai-gateway:sdk' });

const HOME = process.env.HOME || '/home/node';
const CREDENTIALS_SRC = join(HOME, '.claude', 'credentials.json');
const CREDENTIALS_PATH = join(HOME, '.claude', '.credentials.json');
const DEFAULT_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5-20250929';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Ensure credentials are in the correct location.
 *
 * Priority:
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var (long-lived setup-token — preferred)
 * 2. credentials.json file (copied to .credentials.json for SDK)
 *
 * When using a setup-token, no refresh is needed — the token is long-lived.
 */
async function ensureCredentials(): Promise<void> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  // If env var is set, write it as a credentials file for the SDK
  if (envToken) {
    const creds = {
      claudeAiOauth: {
        accessToken: envToken,
        refreshToken: '',
        expiresAt: 4102444800000, // 2100-01-01 — effectively never
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    };
    const json = JSON.stringify(creds);
    try {
      writeFileSync(CREDENTIALS_PATH, json, { mode: 0o600 });
      writeFileSync(CREDENTIALS_SRC, json, { mode: 0o600 });
    } catch { /* may not have permission */ }
    return;
  }

  // Fallback: copy from source file (host may have refreshed it)
  if (existsSync(CREDENTIALS_SRC)) {
    copyFileSync(CREDENTIALS_SRC, CREDENTIALS_PATH);
    try {
      chmodSync(CREDENTIALS_PATH, 0o600);
    } catch { /* may not have permission */ }
  }

  // Check expiry and refresh if needed
  if (!existsSync(CREDENTIALS_PATH)) return;

  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.expiresAt || !oauth?.refreshToken) return;

    // Refresh if token expires within 5 minutes
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() < oauth.expiresAt - fiveMinutes) return;

    logger.info('OAuth token expired or expiring soon — refreshing');

    const resp = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'claude-code/1.0',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }).toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error({ status: resp.status, body: body.substring(0, 300) }, 'OAuth refresh failed — run Keychain export on host');
      return;
    }

    const tokens = await resp.json() as Record<string, any>;
    logger.info('OAuth token refreshed successfully');

    oauth.accessToken = tokens.access_token;
    oauth.refreshToken = tokens.refresh_token ?? oauth.refreshToken;
    oauth.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    const updated = JSON.stringify(creds, null, 2);
    writeFileSync(CREDENTIALS_PATH, updated, { mode: 0o600 });
    writeFileSync(CREDENTIALS_SRC, updated, { mode: 0o600 });

    logger.info({ expiresAt: oauth.expiresAt }, 'Credentials files updated');
  } catch (err) {
    logger.error({ err }, 'Failed to check/refresh credentials');
  }
}

export class SdkProvider implements AiProvider {
  readonly name = 'claude-sdk';

  constructor() {
    ensureCredentials().catch(() => {});
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    await ensureCredentials();

    const startTime = Date.now();
    logger.info({ promptLength: req.userPrompt.length, hasSchema: !!req.jsonSchema }, 'Starting SDK generation');

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      logger.warn({ elapsed: Date.now() - startTime }, 'SDK generation timed out — aborting');
      abortController.abort();
    }, 30 * 60 * 1000);

    const options: Parameters<typeof query>[0]['options'] = {
      systemPrompt: req.systemPrompt,
      model: DEFAULT_MODEL,
      tools: [],
      maxTurns: 50,
      persistSession: false,
      settingSources: [],
      permissionMode: 'dontAsk' as any,
      abortController,
    };

    if (req.jsonSchema) {
      options.outputFormat = {
        type: 'json_schema' as const,
        schema: req.jsonSchema,
      };
    }

    let content = '';
    let model = 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for await (const message of query({ prompt: req.userPrompt, options })) {
      // Fail fast on non-retryable errors (4xx) — never retry auth or client errors
      if (message.type !== 'result') {
        const msg = message as any;
        if (msg.error === 'authentication_failed') {
          clearTimeout(timeout);
          logger.error({ error: msg.error }, 'Auth failed — aborting immediately');
          throw new Error('Authentication failed — OAuth token expired or invalid. Export fresh credentials from Keychain.');
        }
        if (msg.error) {
          // Any SDK turn error that isn't a transient server issue should fail fast
          const errorText = msg.message?.content?.[0]?.text || '';
          const is4xx = /API Error: 4\d\d/.test(errorText);
          if (is4xx) {
            clearTimeout(timeout);
            logger.error({ error: msg.error, content: errorText.substring(0, 300) }, 'Client error (4xx) — aborting immediately');
            throw new Error(`Non-retryable error: ${errorText.substring(0, 200)}`);
          }
          logger.warn({ type: msg.type, error: msg.error, content: errorText.substring(0, 300) }, 'SDK turn error');
        }
      }
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          if (req.jsonSchema && message.structured_output) {
            content = JSON.stringify(message.structured_output);
          } else {
            content = message.result;
          }
        } else {
          const errors = 'errors' in message ? (message as any).errors : [];
          logger.error({ subtype: message.subtype, errors, turns: (message as any).num_turns }, 'Claude SDK error');
          throw new Error(`Claude returned error: ${message.subtype} — ${errors?.join(', ') ?? 'unknown'}`);
        }

        costUsd = message.total_cost_usd ?? 0;

        for (const [modelName, usage] of Object.entries(message.modelUsage)) {
          model = modelName;
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
        }
      }
    }

    clearTimeout(timeout);
    const elapsed = Date.now() - startTime;
    logger.info({ model, inputTokens, outputTokens, costUsd, elapsed }, 'SDK generation complete');

    return { content, model, inputTokens, outputTokens, costUsd };
  }
}
