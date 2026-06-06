import { z } from 'zod';
import { ICommandValidator, validateCommand } from '@quanticjs/core';
import { GenerateSyncCommand } from './generate-sync.command';

export class GenerateSyncValidator implements ICommandValidator<GenerateSyncCommand> {
  private schema = z.object({
    systemPrompt: z.string().min(1, 'System prompt is required').max(100_000),
    userPrompt: z.string().min(1, 'User prompt is required').max(100_000),
    maxTokens: z.number().int().min(1).max(32_000).optional(),
    model: z.string().max(100).optional(),
    jsonSchema: z.record(z.unknown()).optional(),
    purpose: z.string().max(200).optional(),
    callerService: z.string().max(100).optional(),
  });

  validate(command: GenerateSyncCommand) {
    return validateCommand(this.schema, command);
  }
}
