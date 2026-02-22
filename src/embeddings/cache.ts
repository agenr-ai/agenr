interface CacheNode {
  value: number[];
  prev: string | null;
  next: string | null;
}

export class EmbeddingCache {
  private readonly maxSize: number;
  private readonly map = new Map<string, CacheNode>();
  private head: string | null = null; // most recently used key
  private tail: string | null = null; // least recently used key

  constructor(maxSize = 5000) {
    if (maxSize < 1) {
      throw new RangeError("EmbeddingCache maxSize must be at least 1.");
    }
    this.maxSize = maxSize;
  }

  get(text: string): number[] | undefined {
    const node = this.map.get(text);
    if (!node) return undefined;
    this.moveToHead(text, node);
    return node.value;
  }

  set(text: string, embedding: number[]): void {
    if (this.map.has(text)) {
      const node = this.map.get(text)!;
      node.value = embedding;
      this.moveToHead(text, node);
      return;
    }

    if (this.map.size >= this.maxSize) {
      this.evictTail();
    }

    const node: CacheNode = { value: embedding, prev: null, next: this.head };
    this.map.set(text, node);

    if (this.head !== null) {
      this.map.get(this.head)!.prev = text;
    }
    this.head = text;

    if (this.tail === null) {
      this.tail = text;
    }
  }

  get size(): number {
    return this.map.size;
  }

  private moveToHead(key: string, node: CacheNode): void {
    if (this.head === key) return;

    // detach from current position
    if (node.prev !== null) {
      this.map.get(node.prev)!.next = node.next;
    }
    if (node.next !== null) {
      this.map.get(node.next)!.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    // attach at head
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) {
      this.map.get(this.head)!.prev = key;
    }
    this.head = key;
  }

  private evictTail(): void {
    if (this.tail === null) return;
    const tailKey = this.tail;
    const tailNode = this.map.get(tailKey)!;
    this.tail = tailNode.prev;
    if (this.tail !== null) {
      this.map.get(this.tail)!.next = null;
    } else {
      this.head = null;
    }
    this.map.delete(tailKey);
  }
}
