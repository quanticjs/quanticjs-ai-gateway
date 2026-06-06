# Write Backend Tests

## Test Types

### Handler Unit Test
Mock the provider, test Result<T> output:
```typescript
describe('GenerateSyncHandler', () => {
  let handler: GenerateSyncHandler;
  let provider: jest.Mocked<AiProvider>;
  let metrics: GenerateMetrics;

  beforeEach(async () => {
    provider = { name: 'test', generate: jest.fn() };
    metrics = new GenerateMetrics();
    handler = new GenerateSyncHandler(provider, mockLogger(), metrics);
  });

  it('returns success with generation result', async () => {
    provider.generate.mockResolvedValue({
      content: 'hello', model: 'test', inputTokens: 10,
      outputTokens: 5, costUsd: 0.001, durationMs: 100,
    });
    const result = await handler.execute(new GenerateSyncCommand('sys', 'user', undefined, undefined, undefined, undefined, undefined));
    expect(result.isSuccess).toBe(true);
    expect(result.value?.content).toBe('hello');
  });

  it('returns failure on provider error', async () => {
    provider.generate.mockRejectedValue(new Error('API down'));
    const result = await handler.execute(new GenerateSyncCommand('sys', 'user', undefined, undefined, undefined, undefined, undefined));
    expect(result.isSuccess).toBe(false);
  });
});
```

### Validator Unit Test
```typescript
describe('GenerateSyncValidator', () => {
  const validator = new GenerateSyncValidator();

  it('passes valid input', () => {
    const result = validator.validate(new GenerateSyncCommand('sys', 'user', ...));
    expect(result.isSuccess).toBe(true);
  });

  it('fails empty systemPrompt', () => {
    const result = validator.validate(new GenerateSyncCommand('', 'user', ...));
    expect(result.isSuccess).toBe(false);
  });
});
```

## Mandatory Coverage
- Happy path (success)
- Provider error (failure)
- Validation: valid input passes, invalid input fails

## File Naming
- `<handler>.spec.ts` next to handler file

## Rules
- Mock providers, not the framework
- Assert via `result.isSuccess` / `result.value`
- Test both success and failure paths
