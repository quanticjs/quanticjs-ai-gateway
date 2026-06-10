import { Log, Validate } from '@quanticjs/core';
import { SubmitGenerationValidator } from './submit-generation.validator';

// Prompts stay out of logs; only operational fields are allowlisted
@Log({ logPayload: true, logInclude: ['model', 'maxTokens', 'purpose', 'callerService'] })
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
    public readonly metadata: Record<string, unknown> | undefined,
  ) {}
}
