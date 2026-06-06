export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(inputs: string[]): Promise<EmbedResponse>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
