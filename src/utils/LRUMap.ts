/**
 * A Map with LRU (Least Recently Used) eviction.
 *
 * When capacity is exceeded, the least recently accessed entry is evicted.
 * Accessing (get) or updating (set) an entry moves it to the "most recent" position.
 */
export class LRUMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  /**
   * Create a new LRUMap.
   * @param maxSize Maximum number of entries before eviction occurs
   * @param entries Optional initial entries (from another Map or iterable)
   */
  constructor(maxSize: number, entries?: Iterable<readonly [K, V]> | null) {
    super();
    this.maxSize = maxSize;

    if (entries) {
      for (const [key, value] of entries) {
        // Use Map.prototype.set to avoid LRU eviction during initialisation
        super.set(key, value);
      }
      // Trim to maxSize if initial entries exceed capacity (keep most recent)
      while (super.size > this.maxSize) {
        const oldest = super.keys().next().value;
        if (oldest !== undefined) {
          super.delete(oldest);
        }
      }
    }
  }

  /**
   * Get a value and mark it as most recently used.
   */
  get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      // Move to end (most recent) by re-inserting
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  /**
   * Get a value without updating its LRU position.
   * Use this when iterating or checking values without affecting eviction order.
   */
  peek(key: K): V | undefined {
    return super.get(key);
  }

  /**
   * Set a value and mark it as most recently used.
   * If capacity is exceeded, the least recently used entry is evicted.
   */
  set(key: K, value: V): this {
    // If key exists, delete first to update its position
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);

    // Evict oldest if over capacity
    if (super.size > this.maxSize) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) {
        super.delete(oldest);
      }
    }
    return this;
  }

  /**
   * Create a shallow clone of this LRUMap.
   */
  clone(): LRUMap<K, V> {
    return new LRUMap(this.maxSize, this);
  }

  /**
   * Get the maximum capacity of this LRUMap.
   */
  getMaxSize(): number {
    return this.maxSize;
  }
}
