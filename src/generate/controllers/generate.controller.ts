import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { GenerateSyncCommand } from '../commands/generate-sync.command';
import { SubmitGenerationCommand } from '../commands/submit-generation.command';
import { GenerateRequestDto } from '../dtos/generate-request.dto';

@ApiTags('generate')
@Controller('generate')
export class GenerateController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate AI response (synchronous)' })
  @ApiResponse({ status: 200, description: 'AI response generated' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async generateSync(@Body() dto: GenerateRequestDto) {
    return this.commandBus.execute(
      new GenerateSyncCommand(
        dto.systemPrompt,
        dto.userPrompt,
        dto.maxTokens,
        dto.model,
        dto.jsonSchema,
        dto.purpose,
        dto.callerService,
        dto.media,
      ),
    );
  }

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Submit async AI generation (returns requestId)' })
  @ApiResponse({ status: 202, description: 'Generation submitted' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async submitGeneration(@Body() dto: GenerateRequestDto) {
    return this.commandBus.execute(
      new SubmitGenerationCommand(
        dto.systemPrompt,
        dto.userPrompt,
        dto.maxTokens,
        dto.model,
        dto.jsonSchema,
        dto.purpose,
        dto.callerService,
        dto.metadata,
      ),
    );
  }
}
