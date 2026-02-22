import { describe, expect, it } from "vitest";
import { EmbeddingCache } from "../src/embeddings/cache.js";

describe("EmbeddingCache", () => {
  it("returns undefined for cache miss", () => {
    const cache = new EmbeddingCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves an embedding", () => {
    const cache = new EmbeddingCache();
    const vec = [1, 2, 3];
    cache.set("hello", vec);
    expect(cache.get("hello")).toEqual(vec);
  });

  it("evicts LRU entry when at capacity", () => {
    const cache = new EmbeddingCache(3);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]);
    // access "a" to make it recently used; "b" becomes LRU
    cache.get("a");
    cache.set("d", [4]); // should evict "b"
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual([1]);
    expect(cache.get("c")).toEqual([3]);
    expect(cache.get("d")).toEqual([4]);
  });

  it("updates existing entry without growing size", () => {
    const cache = new EmbeddingCache(3);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("a", [99]); // update, not insert
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toEqual([99]);
  });

  it("evicts oldest entry on capacity overflow with no recent access", () => {
    const cache = new EmbeddingCache(2);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]); // should evict "a" (oldest, no access)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual([2]);
    expect(cache.get("c")).toEqual([3]);
  });

  it("size property reflects current entry count", () => {
    const cache = new EmbeddingCache(10);
    expect(cache.size).toBe(0);
    cache.set("a", [1]);
    expect(cache.size).toBe(1);
    cache.set("b", [2]);
    expect(cache.size).toBe(2);
  });

  it("single entry cache evicts on second insert", () => {
    const cache = new EmbeddingCache(1);
    cache.set("a", [1]);
    cache.set("b", [2]);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual([2]);
    expect(cache.size).toBe(1);
  });
});
