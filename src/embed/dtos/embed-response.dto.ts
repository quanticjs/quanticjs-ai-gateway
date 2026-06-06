export class EmbedBatchResponseDto {
  embeddings!: number[][];
  model!: string;
  dimensions!: number;
}

export class EmbedSingleResponseDto {
  embedding!: number[];
  model!: string;
  dimensions!: number;
}
