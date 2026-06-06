import { Validate } from '@quanticjs/core';
import { EmbedTextsValidator } from './embed-texts.validator';

@Validate(EmbedTextsValidator)
export class EmbedTextsCommand {
  constructor(
    public readonly inputs: string[],
    public readonly callerService: string | undefined,
  ) {}
}
