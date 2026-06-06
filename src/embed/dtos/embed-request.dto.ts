import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional, ArrayMinSize, ArrayMaxSize, MaxLength } from 'class-validator';

export class EmbedBatchRequestDto {
  @ApiProperty({ description: 'Array of texts to embed', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @MaxLength(10_000, { each: true })
  inputs!: string[];

  @ApiPropertyOptional({ description: 'Caller service identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  callerService?: string;
}

export class EmbedSingleRequestDto {
  @ApiProperty({ description: 'Text to embed' })
  @IsString()
  @MaxLength(10_000)
  input!: string;

  @ApiPropertyOptional({ description: 'Caller service identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  callerService?: string;
}
