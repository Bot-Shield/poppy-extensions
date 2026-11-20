/**
 * `botshield.ai/approval` with the `assistant` scope: the purchase gate. The account holder approves
 * one assistant to buy for them at this Company, once, with their passkey. At every checkout the
 * Company checks with BotShield, fresh. The person can remove the assistant in the BotShield app,
 * and the next checkout is refused.
 *
 *   const gate = new AssistantGate({ api, agent: 'personal-agents' });
 *   const r = await gate.require({ account, assistant: { clientId, userId }, orderRef, approvalId });
 *   if (!r.allowed) return approvalResponse(r.approval);   // 403: the account holder is asked
 *   // r.checkedAt, r.checkId: this order's fresh answer
 *
 * With `onUnapproved: 'signal'`, `require()` asks nobody: an assistant that isn't approved (never
 * seen, removed, or declined) comes back as `{ allowed: false, match: false }`, and the Company
 * decides what to do with it. `ask()` starts the approval when the Company chooses to.
 *
 * The Company places an Action with the key `assistant` in the Console. BotShield's pairwise ID
 * stays with the Company (the store); it is never sent to the assistant.
 */
import { BotShieldApi, BotShieldError } from './api.ts';
import { isTransient, type ApprovalObject, type TermRow } from './approval.ts';
import { newId, sha256url } from './poppy.ts';
import { operationHash } from './operationHash.ts';
import { MemoryStore, type Store } from './store.ts';

export const ASSISTANT_ACT_KEY = 'assistant';

export interface AssistantRecord {
  id: string;
  lookup: string;
  state: 'requested' | 'approved' | 'declined' | 'expired';
  requestId: string;
  name: string;
  summary: string;
  terms: TermRow[];
  expiresAt: string;
  operationHash: string;
  pairwiseId?: string;
  checkedAt?: number;
}

export interface AssistantGateOptions {
  api: BotShieldApi;
  /** The agent name the Company registered in the Console; the request is shown under it. */
  agent: string;
  store?: Store<AssistantRecord>;
  /** How long the person has to answer, 60–86400 seconds. Default 600. */
  ttlSeconds?: number;
  retryAfter?: number;
  checkEvery?: number;
  /** Reads the assistant's client_name from its Poppy metadata. Injectable for tests. */
  readName?: (clientId: string) => Promise<string | null>;
  /**
   * What `require()` does when the assistant isn't approved: never seen, no match at the check, or
   * declined. `'ask'` (the default) asks the account holder through BotShield and returns the
   * approval object. `'signal'` asks nobody and returns `{ allowed: false, match: false }`; the
   * Company then declines, uses its own checks, or calls `ask()`. An approval already started is
   * followed in both modes.
   */
  onUnapproved?: 'ask' | 'signal';
}

type GateInput = { account: string; assistant: { clientId: string; userId?: string | null }; orderRef: string; approvalId?: string | null };

export type GateResult =
  | { allowed: true; checkedAt: string; checkId: string }
  | { allowed: false; approval: ApprovalObject }
  | { allowed: false; match: false }
  | { allowed: false; refused: 'assistant_unknown' };

export class AssistantGate {
  private readonly opts: AssistantGateOptions;
  private readonly store: Store<AssistantRecord>;
  private readonly ttl: number;
  private readonly retryAfter: number;
  private readonly checkEvery: number;

  constructor(opts: AssistantGateOptions) {
    this.opts = opts;
    this.store = opts.store ?? new MemoryStore<AssistantRecord>();
    this.ttl = Math.min(86400, Math.max(60, opts.ttlSeconds ?? 600));
    this.retryAfter = opts.retryAfter ?? 5;
    this.checkEvery = (opts.checkEvery ?? 10) * 1000;
  }

  /**
   * Call at checkout, after your Poppy Session checks. `assistant.clientId` is the Session's verified
   * `iss`; `assistant.userId` its `sub`. Without Poppy, pass the clientId you know and no userId.
   */
  async require(input: GateInput): Promise<GateResult> {
    return this.run(input, this.opts.onUnapproved ?? 'ask');
  }

  /**
   * Start the account holder's approval for this assistant, when the Company chooses to (for
   * example after `require()` in `'signal'` mode). An approved assistant that still matches is
   * allowed without asking; an approval already waiting is returned as it stands.
   */
  async ask(input: GateInput): Promise<GateResult> {
    return this.run(input, 'ask');
  }

  private async run(input: GateInput, mode: 'ask' | 'signal'): Promise<GateResult> {
    const { clientId } = input.assistant;
    const userId = input.assistant.userId ?? null;
    const lookup = `${input.account}\n${clientId}\n${userId ?? ''}`;
    let rec = (input.approvalId ? await this.store.get(input.approvalId) : null) ?? (await this.store.find(lookup));
    if (rec && rec.lookup !== lookup) rec = null;

    if (rec?.pairwiseId) {
      const c = await this.opts.api.assistantCheck({ partnerUserRef: input.account, pairwiseId: rec.pairwiseId, clientId, assistantUserId: userId, orderRef: input.orderRef });
      if (c.match) return { allowed: true, checkedAt: c.checked_at, checkId: c.check_id };
      if (mode === 'signal') return { allowed: false, match: false };
      rec = null; // removed by the person, or replaced: ask again
    }
    if (rec && rec.state === 'requested') rec = await this.refresh(rec, input.account, clientId, userId);
    if (rec?.pairwiseId) return this.run({ ...input, approvalId: null }, mode);
    if (rec && (rec.state === 'declined' || rec.state === 'expired') && input.approvalId) return { allowed: false, approval: toObject(rec, this.retryAfter) };
    if (!rec || rec.state === 'declined' || rec.state === 'expired') {
      if (mode === 'signal') return { allowed: false, match: false };
      const started = await this.start(input.account, clientId, userId, lookup);
      return 'refused' in started ? started : { allowed: false, approval: toObject(started, this.retryAfter) };
    }
    return { allowed: false, approval: toObject(rec, this.retryAfter) };
  }

  private async start(account: string, clientId: string, userId: string | null, lookup: string): Promise<AssistantRecord | { allowed: false; refused: 'assistant_unknown' }> {
    const name = await (this.opts.readName ?? readAssistantName)(clientId);
    if (!name) return { allowed: false, refused: 'assistant_unknown' };
    const id = newId('apv');
    const requestId = crypto.randomUUID();
    const summary = `Let ${name} buy for you`;
    let host = clientId;
    try { host = new URL(clientId).host; } catch { /* the engine refuses it */ }
    const terms: TermRow[] = [
      { label: 'Assistant', value: name.slice(0, 80) },
      { label: 'From', value: host.slice(0, 80) },
      { label: 'It can', value: 'Buy for you here, until you remove it' },
    ];
    const digest = await sha256url(`${clientId}\n${userId ?? ''}`);
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + this.ttl * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const opHash = await operationHash({ operation_id: id, revision: digest, summary, terms: { rows: terms }, expires_at: expiresAt });
    const started = await this.opts.api.requestAction({
      requestId, agent: this.opts.agent, act: `${ASSISTANT_ACT_KEY}:${digest}`, actLabel: summary,
      partnerUserRef: account, details: terms, ttlSeconds: this.ttl,
    });
    const rec: AssistantRecord = { id, lookup, state: 'requested', requestId, name, summary, terms, expiresAt: started.expires_at, operationHash: opHash };
    await this.store.put(rec);
    return rec;
  }

  private async refresh(rec: AssistantRecord, account: string, clientId: string, userId: string | null): Promise<AssistantRecord> {
    if (rec.checkedAt && Date.now() - rec.checkedAt < this.checkEvery) return rec;
    const checked = { ...rec, checkedAt: Date.now() };
    try {
      const s = await this.opts.api.actionStatus({ requestId: rec.requestId, agent: this.opts.agent });
      let next: AssistantRecord = checked;
      if (s.status === 'denied' || s.status === 'cancelled') next = { ...checked, state: 'declined' };
      else if (s.status === 'expired') next = { ...checked, state: 'expired' };
      else if (s.status === 'approved') {
        // The approval is BotShield's record now; registering returns the pairwise ID.
        const reg = await this.opts.api.assistantRegister({ requestId: rec.requestId, partnerUserRef: account, clientId, assistantUserId: userId });
        next = { ...checked, state: 'approved', pairwiseId: reg.pairwise_id };
      }
      await this.store.swap(next, 'requested');
      return next;
    } catch (e) {
      if (isTransient(e)) {
        await this.store.swap(checked, 'requested');
        return checked;
      }
      if (e instanceof BotShieldError && e.code === 'not_approved') {
        const next = { ...checked, state: 'expired' as const };
        await this.store.swap(next, 'requested');
        return next;
      }
      throw e;
    }
  }
}

function toObject(rec: AssistantRecord, retryAfter: number): ApprovalObject {
  const state = rec.state === 'approved' ? 'approved' : rec.state;
  return {
    approval_id: rec.id,
    state,
    summary: rec.summary,
    terms: rec.terms,
    expires_at: rec.expiresAt,
    ...(state === 'requested' ? { retry_after: retryAfter } : {}),
    operation_hash: rec.operationHash,
  };
}

/** The assistant's client_name from its Poppy metadata: HTTPS, no redirects, client_id must match. */
export async function readAssistantName(clientId: string): Promise<string | null> {
  try {
    const url = new URL(clientId);
    if (url.protocol !== 'https:') return null;
    const res = await fetch(url.href, { redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    if (res.status !== 200) return null;
    const doc = (await res.json()) as { client_id?: unknown; client_name?: unknown };
    if (doc.client_id !== url.href && doc.client_id !== clientId) return null;
    const name = typeof doc.client_name === 'string' ? doc.client_name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return name && name.length <= 60 ? name : null;
  } catch {
    return null;
  }
}
