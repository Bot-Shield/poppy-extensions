/**
 * One Durable Object holds the demo's state: the approvals and presence checks between an
 * assistant's repeated requests (so `swap` is atomic, as at-most-once needs), and the trace the demo
 * page shows. A demo, so one object for everything.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Store } from '../../../packages/poppy/src/store.ts';

export type TraceEntry = {
  at: string;
  flow: string;
  lane: 'assistant' | 'company' | 'botshield' | 'phone';
  title: string;
  detail?: unknown;
};

export class DemoState extends DurableObject {
  async get(ns: string, id: string): Promise<unknown | null> {
    return (await this.ctx.storage.get(`${ns}:id:${id}`)) ?? null;
  }
  async find(ns: string, lookup: string): Promise<unknown | null> {
    const id = await this.ctx.storage.get<string>(`${ns}:lookup:${lookup}`);
    return id ? this.get(ns, id) : null;
  }
  async put(ns: string, rec: { id: string; lookup: string }): Promise<void> {
    await this.ctx.storage.put({ [`${ns}:id:${rec.id}`]: rec, [`${ns}:lookup:${rec.lookup}`]: rec.id });
  }
  /** Atomic: a Durable Object handles one call at a time. */
  async swap(ns: string, rec: { id: string; lookup: string; state: string }, expectState: string): Promise<boolean> {
    const cur = (await this.get(ns, rec.id)) as { state?: string } | null;
    if (!cur || cur.state !== expectState) return false;
    await this.put(ns, rec);
    return true;
  }
  async trace(entry: TraceEntry): Promise<void> {
    const list = ((await this.ctx.storage.get<TraceEntry[]>('trace')) ?? []).slice(-199);
    list.push(entry);
    await this.ctx.storage.put('trace', list);
  }
  async traces(): Promise<TraceEntry[]> {
    return (await this.ctx.storage.get<TraceEntry[]>('trace')) ?? [];
  }
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // ── General storage for the Atlas-style demo: chats, OAuth, the simulated BotShield ───────────

  async kvGet(key: string): Promise<any> {
    const v = (await this.ctx.storage.get<{ v: unknown; exp?: number }>(`kv:${key}`)) ?? null;
    if (!v) return null;
    if (v.exp && v.exp < Date.now()) {
      await this.ctx.storage.delete(`kv:${key}`);
      return null;
    }
    return v.v;
  }
  async kvPut(key: string, value: unknown, ttlMs?: number): Promise<void> {
    await this.ctx.storage.put(`kv:${key}`, { v: value, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) });
    await this.scheduleSweep();
  }
  async kvDel(key: string): Promise<void> {
    await this.ctx.storage.delete(`kv:${key}`);
  }
  /** Read and delete in one step: authorization codes are good once. */
  async kvTake(key: string): Promise<any> {
    const v = await this.kvGet(key);
    await this.ctx.storage.delete(`kv:${key}`);
    return v;
  }
  /** Set only if absent. False when it was already there (a reused `jti`, a held lock). */
  async kvAdd(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if ((await this.kvGet(key)) !== null) return false;
    await this.kvPut(key, value, ttlMs);
    return true;
  }
  /** The key suffixes under a prefix (live entries only). */
  async kvList(prefix: string): Promise<string[]> {
    const m = await this.ctx.storage.list<{ exp?: number }>({ prefix: `kv:${prefix}`, limit: 200 });
    return [...m].filter(([, v]) => !v?.exp || v.exp > Date.now()).map(([k]) => k.slice(`kv:${prefix}`.length));
  }
  async kvDelPrefix(prefix: string): Promise<number> {
    const keys = [...(await this.ctx.storage.list({ prefix: `kv:${prefix}` })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    return keys.length;
  }
  /** Counts a hit in a fixed window. */
  async hit(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; count: number }> {
    const bucket = Math.floor(Date.now() / windowMs);
    const k = `${key}:${bucket}`;
    const count = ((await this.kvGet(k)) ?? 0) + 1;
    await this.kvPut(k, count, windowMs * 2);
    return { ok: count <= limit, count };
  }
  /** Appends to a list, in order. Returns the item's sequence number. */
  async append(list: string, item: Record<string, unknown>): Promise<number> {
    const seq = ((await this.kvGet(`${list}:n`)) ?? 0) + 1;
    await this.ctx.storage.put({ [`kv:${list}:n`]: { v: seq, exp: Date.now() + DAY }, [`kv:${list}:i:${String(seq).padStart(6, '0')}`]: { v: { ...item, seq }, exp: Date.now() + DAY } });
    await this.scheduleSweep();
    return seq;
  }
  async since(list: string, after: number): Promise<Array<Record<string, unknown>>> {
    const m = await this.ctx.storage.list<{ v: Record<string, unknown> }>({ prefix: `kv:${list}:i:`, start: `kv:${list}:i:${String(after + 1).padStart(6, '0')}`, limit: 500 });
    return [...m.values()].map((x) => x.v);
  }

  /** Expired entries (chats, codes, tokens) are removed every few hours. */
  private async scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 3 * 3600_000);
  }
  async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.ctx.storage.list<{ exp?: number }>({ prefix: 'kv:' });
    const dead = [...all].filter(([, v]) => v && typeof v === 'object' && v.exp && v.exp < now).map(([k]) => k);
    for (let i = 0; i < dead.length; i += 128) await this.ctx.storage.delete(dead.slice(i, i + 128));
    if (all.size > dead.length) await this.ctx.storage.setAlarm(now + 3 * 3600_000);
  }
}

const DAY = 24 * 3600_000;

/** The Durable Object's methods as callers use them (RPC stubs don't carry generic signatures). */
export interface DemoStub {
  get(ns: string, id: string): Promise<unknown | null>;
  find(ns: string, lookup: string): Promise<unknown | null>;
  put(ns: string, rec: { id: string; lookup: string }): Promise<void>;
  swap(ns: string, rec: { id: string; lookup: string; state: string }, expectState: string): Promise<boolean>;
  trace(entry: TraceEntry): Promise<void>;
  traces(): Promise<TraceEntry[]>;
  reset(): Promise<void>;
  kvGet<T = any>(key: string): Promise<T | null>;
  kvTake<T = any>(key: string): Promise<T | null>;
  kvPut(key: string, value: unknown, ttlMs?: number): Promise<void>;
  kvDel(key: string): Promise<void>;
  kvAdd(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  kvList(prefix: string): Promise<string[]>;
  kvDelPrefix(prefix: string): Promise<number>;
  hit(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; count: number }>;
  append(list: string, item: Record<string, unknown>): Promise<number>;
  since(list: string, after: number): Promise<Array<Record<string, unknown>>>;
}

/** The package's Store, backed by the Durable Object. */
export function doStore<R extends { id: string; lookup: string; state: string }>(stub: DemoStub, ns: string): Store<R> {
  return {
    get: async (id) => (await stub.get(ns, id)) as R | null,
    find: async (lookup) => (await stub.find(ns, lookup)) as R | null,
    put: async (rec) => { await stub.put(ns, rec); },
    swap: async (rec, expect) => stub.swap(ns, rec, expect),
  };
}
