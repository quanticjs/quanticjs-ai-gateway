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
      overrides.media,
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

  describe('media', () => {
    const validMedia = [
      { url: 'http://files:9000/a.pdf?sig=x', kind: 'document' as const, mediaType: 'application/pdf' },
      { url: 'https://files/b.png', kind: 'image' as const, mediaType: 'image/png', fileName: 'b.png' },
    ];

    it('should pass with valid media refs', () => {
      const result = validator.validate(cmd({ media: validMedia }));
      expect(result.isSuccess).toBe(true);
    });

    it('should pass with no media (optional)', () => {
      const result = validator.validate(cmd({ media: undefined }));
      expect(result.isSuccess).toBe(true);
    });

    it('should fail when a media url is not a valid URL', () => {
      const result = validator.validate(cmd({ media: [{ url: 'not-a-url', kind: 'document', mediaType: 'application/pdf' }] }));
      expect(result.isSuccess).toBe(false);
      expect(result.errorType).toBe(ErrorType.ValidationError);
    });

    it('should fail when media kind is not document/image', () => {
      const result = validator.validate(cmd({ media: [{ url: 'http://f/a', kind: 'video' as never, mediaType: 'video/mp4' }] }));
      expect(result.isSuccess).toBe(false);
      expect(result.errorType).toBe(ErrorType.ValidationError);
    });

    it('should fail when media array exceeds the cap', () => {
      const many = Array.from({ length: 11 }, () => validMedia[0]!);
      const result = validator.validate(cmd({ media: many }));
      expect(result.isSuccess).toBe(false);
      expect(result.errorType).toBe(ErrorType.ValidationError);
    });
  });
});
