/**
 * Where the Company keeps its requests for approval and its presence checks between a Personal
 * Agent's repeated requests. The default keeps them in memory, which suits one process. With several
 * servers, implement this interface on a shared store (Redis, Postgres) — `put` must be atomic per id.
 */
export interface Store<R extends { id: string; lookup: string }> {
  get(id: string): Promise<R | null>;
  /** The newest record with this lookup key, if any. */
  find(lookup: string): Promise<R | null>;
  put(record: R): Promise<void>;
  /**
   * Set `record` only if the stored one still has `expectState`. Returns false when another request
   * changed it first. This is what keeps an action to at most once.
   */
  swap(record: R & { state: string }, expectState: string): Promise<boolean>;
}

export class MemoryStore<R extends { id: string; lookup: string; state: string }> implements Store<R> {
  private readonly byId = new Map<string, R>();
  private readonly byLookup = new Map<string, string>();

  async get(id: string): Promise<R | null> {
    return this.byId.get(id) ?? null;
  }

  async find(lookup: string): Promise<R | null> {
    const id = this.byLookup.get(lookup);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async put(record: R): Promise<void> {
    this.byId.set(record.id, record);
    this.byLookup.set(record.lookup, record.id);
  }

  async swap(record: R, expectState: string): Promise<boolean> {
    const cur = this.byId.get(record.id);
    if (!cur || cur.state !== expectState) return false;
    await this.put(record);
    return true;
  }
}
