import { ErrorType } from '@quanticjs/core';
import { EmbedTextsValidator } from './embed-texts.validator';
import { EmbedTextsCommand } from './embed-texts.command';

describe('EmbedTextsValidator', () => {
  const validator = new EmbedTextsValidator();

  function cmd(overrides: Partial<EmbedTextsCommand> = {}): EmbedTextsCommand {
    return new EmbedTextsCommand(
      overrides.inputs ?? ['hello world'],
      overrides.callerService,
    );
  }

  it('should pass with a single input', () => {
    const result = validator.validate(cmd({ inputs: ['hello'] }));
    expect(result.isSuccess).toBe(true);
  });

  it('should pass with multiple inputs', () => {
    const result = validator.validate(cmd({ inputs: ['a', 'b', 'c'] }));
    expect(result.isSuccess).toBe(true);
  });

  it('should pass with optional callerService', () => {
    const result = validator.validate(cmd({ callerService: 'my-service' }));
    expect(result.isSuccess).toBe(true);
  });

  it('should fail when inputs is empty', () => {
    const result = validator.validate(cmd({ inputs: [] }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should fail when inputs exceeds 256 items', () => {
    const result = validator.validate(cmd({ inputs: Array.from({ length: 257 }, (_, i) => `text-${i}`) }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should accept exactly 256 inputs', () => {
    const result = validator.validate(cmd({ inputs: Array.from({ length: 256 }, (_, i) => `text-${i}`) }));
    expect(result.isSuccess).toBe(true);
  });

  it('should fail when a single input exceeds 10000 chars', () => {
    const result = validator.validate(cmd({ inputs: ['x'.repeat(10_001)] }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });

  it('should accept input at exactly 10000 chars', () => {
    const result = validator.validate(cmd({ inputs: ['x'.repeat(10_000)] }));
    expect(result.isSuccess).toBe(true);
  });

  it('should fail when callerService exceeds 100 chars', () => {
    const result = validator.validate(cmd({ callerService: 'x'.repeat(101) }));
    expect(result.isSuccess).toBe(false);
    expect(result.errorType).toBe(ErrorType.ValidationError);
  });
});
