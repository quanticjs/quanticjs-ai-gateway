import { selectAiProvider } from './generate.module';
import type { AiProvider } from './services/ai-provider.interface';

// Stub providers tagged by name — selectAiProvider only switches on the config value,
// so identity-by-name is enough to assert which one is chosen.
const sdk = { name: 'claude-sdk' } as AiProvider;
const anthropic = { name: 'anthropic-api' } as AiProvider;
const openai = { name: 'openai' } as AiProvider;
const all = { sdk, anthropic, openai };

describe('selectAiProvider (AI_PROVIDER factory)', () => {
  it("returns the OpenAI provider when AI_PROVIDER='openai'", () => {
    expect(selectAiProvider('openai', all)).toBe(openai);
  });

  it("returns the Anthropic provider when AI_PROVIDER='anthropic-api'", () => {
    expect(selectAiProvider('anthropic-api', all)).toBe(anthropic);
  });

  it("defaults to the Claude SDK provider for 'claude-sdk'", () => {
    expect(selectAiProvider('claude-sdk', all)).toBe(sdk);
  });

  it('defaults to the Claude SDK provider for any unknown value (regression: default unchanged)', () => {
    expect(selectAiProvider('something-else', all)).toBe(sdk);
    expect(selectAiProvider('', all)).toBe(sdk);
  });
});
