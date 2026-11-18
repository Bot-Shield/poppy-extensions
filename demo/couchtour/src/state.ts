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
}

/** The package's Store, backed by the Durable Object. */
export function doStore<R extends { id: string; lookup: string; state: string }>(stub: DurableObjectStub<DemoState>, ns: string): Store<R> {
  return {
    get: async (id) => (await stub.get(ns, id)) as R | null,
    find: async (lookup) => (await stub.find(ns, lookup)) as R | null,
    put: async (rec) => { await stub.put(ns, rec); },
    swap: async (rec, expect) => stub.swap(ns, rec, expect),
  };
}
