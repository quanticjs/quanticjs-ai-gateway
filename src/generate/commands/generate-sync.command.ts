import { Validate } from '@quanticjs/core';
import { GenerateSyncValidator } from './generate-sync.validator';

@Validate(GenerateSyncValidator)
export class GenerateSyncCommand {
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
