import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EmbedTextsCommand } from '../commands/embed-texts.command';
import { EmbedBatchRequestDto, EmbedSingleRequestDto } from '../dtos/embed-request.dto';

@ApiTags('embed')
@Controller('embed')
export class EmbedController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Embed batch of texts' })
  @ApiResponse({ status: 200, description: 'Embeddings generated' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async embedBatch(@Body() dto: EmbedBatchRequestDto) {
    return this.commandBus.execute(
      new EmbedTextsCommand(dto.inputs, dto.callerService),
    );
  }

  @Post('single')
  @HttpCode(200)
  @ApiOperation({ summary: 'Embed a single text' })
  @ApiResponse({ status: 200, description: 'Embedding generated' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async embedSingle(@Body() dto: EmbedSingleRequestDto) {
    const result = await this.commandBus.execute(
      new EmbedTextsCommand([dto.input], dto.callerService),
    );

    if (result?.value) {
      return {
        ...result,
        value: {
          embedding: result.value.embeddings[0],
          model: result.value.model,
          dimensions: result.value.dimensions,
        },
      };
    }

    return result;
  }
}
