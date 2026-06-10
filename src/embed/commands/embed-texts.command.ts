import { Log, Validate } from '@quanticjs/core';
import { EmbedTextsValidator } from './embed-texts.validator';

// Embedding inputs stay out of logs; only the caller is allowlisted
@Log({ logPayload: true, logInclude: ['callerService'] })
@Validate(EmbedTextsValidator)
export class EmbedTextsCommand {
  constructor(
    public readonly inputs: string[],
    public readonly callerService: string | undefined,
  ) {}
}
