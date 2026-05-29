import express from 'express';
import pino from 'pino';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { AiProvider, GenerateRequest, GenerateResult } from './types.js';
import { SdkProvider } from './providers/SdkProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';

const logger = pino({ name: 'ai-gateway' });
const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = parseInt(process.env.PORT || '3005', 10);

// Redis Stream for async results
const RESULT_STREAM = 'arex:ai:results';
const STREAM_MAXLEN = 10000;

// Redis connection
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
});

redis.on('error', (err) => logger.error({ error: err.message }, 'Redis connection error'));
redis.on('connect', () => logger.info('Connected to Redis'));

// Provider selection — env var decides which backend to use
const PROVIDER_NAME = process.env.AI_PROVIDER || 'claude-sdk';

function createProvider(): AiProvider {
  switch (PROVIDER_NAME) {
    case 'anthropic-api':
      return new AnthropicProvider();
    case 'claude-sdk':
    default:
      return new SdkProvider();
  }
}

const provider = createProvider();
logger.info({ provider: provider.name }, 'AI provider initialized');

// ── Redis Stream publisher ──────────────────────────────────────────

async function publishResult(result: GenerateResult): Promise<void> {
  try {
    await redis.xadd(
      RESULT_STREAM,
      'MAXLEN', '~', String(STREAM_MAXLEN),
      '*',
      'requestId', result.requestId,
      'status', result.status,
      'content', result.content,
      'model', result.model,
      'inputTokens', String(result.inputTokens),
      'outputTokens', String(result.outputTokens),
      'costUsd', String(result.costUsd),
      'error', result.error || '',
    );
    logger.info({ requestId: result.requestId, status: result.status }, 'Published result to stream');
  } catch (error) {
    logger.error({ requestId: result.requestId, error: (error as Error).message }, 'Failed to publish result');
  }
}

// ── Async processing ────────────────────────────────────────────────

async function processAsync(requestId: string, req: GenerateRequest): Promise<void> {
  try {
    const result = await provider.generate(req);
    await publishResult({
      requestId,
      status: 'success',
      ...result,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ requestId, error: msg }, 'Generation failed');
    await publishResult({
      requestId,
      status: 'error',
      content: '',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: msg,
    });
  }
}

// ── Routes ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ai-gateway', provider: provider.name, redis: redis.status });
});

// Async endpoint — returns 202 immediately, publishes result to Redis Stream
app.post('/generate', (req, res) => {
  const body = req.body as GenerateRequest;

  if (!body.systemPrompt || !body.userPrompt) {
    res.status(400).json({ error: 'systemPrompt and userPrompt are required' });
    return;
  }

  const requestId = body.requestId || randomUUID();

  res.status(202).json({ requestId, stream: RESULT_STREAM });

  processAsync(requestId, body);
});

// Sync endpoint — blocks until result is ready (for simple callers / testing)
app.post('/generate/sync', async (req, res) => {
  const body = req.body as GenerateRequest;

  if (!body.systemPrompt || !body.userPrompt) {
    res.status(400).json({ error: 'systemPrompt and userPrompt are required' });
    return;
  }

  try {
    const result = await provider.generate(body);
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: msg }, 'Sync generation failed');
    res.status(500).json({ error: msg });
  }
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, provider: provider.name, resultStream: RESULT_STREAM }, 'AI Gateway listening');
});
