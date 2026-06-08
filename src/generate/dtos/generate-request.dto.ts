import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max, MaxLength, IsObject } from 'class-validator';

export class GenerateRequestDto {
  @ApiProperty({ description: 'System prompt for the AI model' })
  @IsString()
  @MaxLength(100_000)
  systemPrompt!: string;

  @ApiProperty({ description: 'User prompt / input for the AI model' })
  @IsString()
  @MaxLength(100_000)
  userPrompt!: string;

  @ApiPropertyOptional({ description: 'Maximum tokens in response', default: 8192 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32_000)
  maxTokens?: number;

  @ApiPropertyOptional({ description: 'Model override (defaults to server config)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ description: 'JSON schema for structured output' })
  @IsOptional()
  @IsObject()
  jsonSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Purpose label for usage tracking' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  purpose?: string;

  @ApiPropertyOptional({ description: 'Caller service identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  callerService?: string;

  @ApiPropertyOptional({ description: 'Pass-through metadata returned in the response event' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
