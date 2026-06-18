import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsObject,
  IsArray,
  ValidateNested,
  IsIn,
  IsUrl,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MediaRefDto {
  @ApiProperty({ description: 'URL the gateway fetches server-side (e.g. presigned read URL)' })
  @IsUrl({ require_tld: false })
  @MaxLength(4096)
  url!: string;

  @ApiProperty({ description: 'How the model should treat the file', enum: ['document', 'image'] })
  @IsIn(['document', 'image'])
  kind!: 'document' | 'image';

  @ApiProperty({ description: 'IANA media type, e.g. application/pdf or image/png' })
  @IsString()
  @MaxLength(255)
  mediaType!: string;

  @ApiPropertyOptional({ description: 'Original file name (for logging/labels)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

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

  @ApiPropertyOptional({
    description: 'Multimodal file references; the gateway fetches each URL and forwards bytes to the model',
    type: [MediaRefDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MediaRefDto)
  media?: MediaRefDto[];
}
