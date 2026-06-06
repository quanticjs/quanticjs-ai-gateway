import { z } from 'zod';
import { ICommandValidator, validateCommand } from '@quanticjs/core';
import { EmbedTextsCommand } from './embed-texts.command';

export class EmbedTextsValidator implements ICommandValidator<EmbedTextsCommand> {
  private schema = z.object({
    inputs: z.array(z.string().max(10_000)).min(1).max(256),
    callerService: z.string().max(100).optional(),
  });

  validate(command: EmbedTextsCommand) {
    return validateCommand(this.schema, command);
  }
}
