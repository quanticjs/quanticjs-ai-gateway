import { z } from 'zod';

/**
 * CANARY (out of band — run via `npm run test:canary`, never in `npm test`/PR CI).
 *
 * Asserts the Chat Completions response SHAPE the OpenAiGenerationProvider depends on still holds
 * against the REAL OpenAI/Azure endpoint. Asserts shape only — never generated content (it is
 * non-deterministic). Self-skips when OPENAI_API_KEY is absent.
 *
 * Drift signal: this fails while the mocked unit tests pass ⇒ the provider's assumed response
 * shape (`choices[0].message.content`, `usage.prompt_tokens`/`completion_tokens`, `model`) drifted.
 */
const responseSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string(),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
});

const apiKey = process.env.OPENAI_API_KEY ?? '';
const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const model = process.env.OPENAI_GENERATION_MODEL ?? 'gpt-4.1';
const isAzure = process.env.OPENAI_API_TYPE === 'azure' || /\.azure\.com/i.test(baseUrl);
const azureDeployment = process.env.AZURE_OPENAI_GEN_DEPLOYMENT ?? model;
const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';

const enabled = Boolean(apiKey);

(enabled ? describe : describe.skip)('CANARY: OpenAI/Azure Chat Completions contract', () => {
  it('chat/completions response still matches the provider contract', async () => {
    const url = isAzure
      ? `${baseUrl}/openai/deployments/${azureDeployment}/chat/completions?api-version=${azureApiVersion}`
      : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = isAzure
      ? { 'Content-Type': 'application/json', 'api-key': apiKey }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

    const body: Record<string, unknown> = {
      max_tokens: 16,
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'OK' },
      ],
    };
    if (!isAzure) body.model = model;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.ok).toBe(true);

    const data = await res.json();
    expect(() => responseSchema.parse(data)).not.toThrow();
  });
});
