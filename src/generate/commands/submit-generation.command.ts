import { Validate } from '@quanticjs/core';
import { SubmitGenerationValidator } from './submit-generation.validator';

@Validate(SubmitGenerationValidator)
export class SubmitGenerationCommand {
  constructor(
    public readonly systemPrompt: string,
    public readonly userPrompt: string,
    public readonly maxTokens: number | undefined,
    public readonly model: string | undefined,
    public readonly jsonSchema: Record<string, unknown> | undefined,
    public readonly purpose: string | undefined,
    public readonly callerService: string | undefined,
  ) {}
}
