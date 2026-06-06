import { ErrorType } from '@quanticjs/core';
import { GenerateSyncValidator } from './generate-sync.validator';
import { GenerateSyncCommand } from './generate-sync.command';

describe('GenerateSyncValidator', () => {
  const validator = new GenerateSyncValidator();

  function cmd(overrides: Partial<GenerateSyncCommand> = {}): GenerateSyncCommand {
    return new GenerateSyncCommand(
      overrides.systemPrompt ?? 'You are a helpful assistant',
      overrides.userPrompt ?? 'Hello',
      overrides.maxTokens,
      overrides.model,
      overrides.jsonSchema,
      overrides.purpose,
      overrides.callerService,
    );
  }

  it('should pass with valid required fields only', () => {
    const result = validator.validate(cmd());
    expect(result.isSuccess).toBe(true);
  });

  it('should pass with all optional fields', () => {
    const result = validator.validate(cmd({
      maxTokens: 4096,
      model: 'claude-opus-4-20250514',
      jsonSchema: { type: 'object' },
      purpose: 'summarize',
      callerService: 'my-service',
    }));
    expect(result.isSuccess).toBe(true);
  });

  it('should fail when systemPrompt is empty', () => {
    const result = validator.validate(cmd({ systemPrompt: '' }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when userPrompt is empty', () => {
    const result = validator.validate(cmd({ userPrompt: '' }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when maxTokens is 0', () => {
    const result = validator.validate(cmd({ maxTokens: 0 }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when maxTokens exceeds 32000', () => {
    const result = validator.validate(cmd({ maxTokens: 32_001 }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when maxTokens is not an integer', () => {
    const result = validator.validate(cmd({ maxTokens: 1.5 }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when model exceeds 100 chars', () => {
    const result = validator.validate(cmd({ model: 'x'.repeat(101) }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when purpose exceeds 200 chars', () => {
    const result = validator.validate(cmd({ purpose: 'x'.repeat(201) }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when callerService exceeds 100 chars', () => {
    const result = validator.validate(cmd({ callerService: 'x'.repeat(101) }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });
});
