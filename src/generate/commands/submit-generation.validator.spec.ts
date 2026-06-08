import { ErrorType } from '@quanticjs/core';
import { SubmitGenerationValidator } from './submit-generation.validator';
import { SubmitGenerationCommand } from './submit-generation.command';

describe('SubmitGenerationValidator', () => {
  const validator = new SubmitGenerationValidator();

  function cmd(overrides: Partial<SubmitGenerationCommand> = {}): SubmitGenerationCommand {
    return new SubmitGenerationCommand(
      overrides.systemPrompt ?? 'You are a helpful assistant',
      overrides.userPrompt ?? 'Hello',
      overrides.maxTokens,
      overrides.model,
      overrides.jsonSchema,
      overrides.purpose,
      overrides.callerService,
      overrides.metadata,
    );
  }

  it('should pass with valid required fields only', () => {
    const result = validator.validate(cmd());
    expect(result.isSuccess).toBe(true);
  });

  it('should pass with all optional fields', () => {
    const result = validator.validate(cmd({
      maxTokens: 1024,
      model: 'claude-haiku-4-5-20251001',
      jsonSchema: { type: 'string' },
      purpose: 'classify',
      callerService: 'worker',
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

  it('should fail when maxTokens is negative', () => {
    const result = validator.validate(cmd({ maxTokens: -1 }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when maxTokens exceeds 32000', () => {
    const result = validator.validate(cmd({ maxTokens: 32_001 }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should accept maxTokens at boundary values', () => {
    expect(validator.validate(cmd({ maxTokens: 1 })).isSuccess).toBe(true);
    expect(validator.validate(cmd({ maxTokens: 32_000 })).isSuccess).toBe(true);
  });
});
