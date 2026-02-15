export class EmbeddingCache {
  private readonly embeddings = new Map<string, number[]>();

  get(text: string): number[] | undefined {
    return this.embeddings.get(text);
  }

  set(text: string, embedding: number[]): void {
    this.embeddings.set(text, embedding);
  }
}
