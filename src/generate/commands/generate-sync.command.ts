import { Log, Validate } from '@quanticjs/core';
import { GenerateSyncValidator } from './generate-sync.validator';
import type { AiMediaRef } from '../services/ai-provider.interface';

// Prompts and media URLs (presigned — may carry signatures) stay out of logs;
// only operational fields are allowlisted.
@Log({ logPayload: true, logInclude: ['model', 'maxTokens', 'purpose', 'callerService'] })
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
    public readonly media: AiMediaRef[] | undefined = undefined,
  ) {}
}
