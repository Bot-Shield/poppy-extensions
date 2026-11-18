/**
 * `botshield.ai/approval` version 1, the Company's side. See extensions/approval/SPEC.md.
 *
 *   const approvals = new AccountHolderApproval({ api, agent: 'Poppy', actionKey: 'plan' });
 *   const r = await approvals.require({ account, client, approvalId, meaning, summary, terms });
 *   if (!r.approved) return approvalResponse(r.approval);          // 403, the person is asked
 *   return r.perform(() => changePlan(...));                        // once, however often it's repeated
 */
import { BotShieldApi, BotShieldError } from './api.ts';
import { APPROVAL_EXTENSION, newId, sha256url } from './poppy.ts';
import { operationHash } from './operationHash.ts';
import { MemoryStore, type Store } from './store.ts';

export type ApprovalState = 'requested' | 'approved' | 'declined' | 'expired';
export type TermRow = { label: string; value: string };

/** The approval object the Personal Agent sees (SPEC section 5). */
export interface ApprovalObject {
  approval_id: string;
  state: ApprovalState;
  summary: string;
  terms: TermRow[];
  expires_at: string;
  retry_after?: number;
  /**
   * The shared operation hash (PAP #71/#74) of this request: `operation_id` = `approval_id`,
   * `revision` = a digest of what the request asks for, `summary`, `terms` = `{ rows }`, and
   * `expires_at`. The signed answer is bound to it.
   */
  operation_hash: string;
}

export interface ApprovalRecord {
  id: string;
  lookup: string;
  state: 'requested' | 'approved' | 'performing' | 'performed' | 'declined' | 'expired';
  account: string;
  client: string;
  digest: string;
  requestId: string;
  act: string;
  summary: string;
  terms: TermRow[];
  expiresAt: string;
  operationHash: string;
  result?: unknown;
  /** When BotShield was last asked (ms), so repeats inside `checkEvery` don't call it again. */
  checkedAt?: number;
}

export type RequireResult<T = unknown> =
  | { approved: true; approvalId: string; perform: (action: () => Promise<T>) => Promise<T> }
  | { approved: false; approval: ApprovalObject };

/** The account isn't linked to BotShield: nothing was sent. Handle the action without this extension. */
export class NotLinkedError extends Error {
  constructor() {
    super('This account is not linked to BotShield, so the account holder cannot be asked.');
    this.name = 'NotLinkedError';
  }
}

/** The action is being performed by another request. Answer HTTP 503 with Retry-After. */
export class StillPerformingError extends Error {
  readonly retryAfter = 2;
  constructor() {
    super('This action is being performed. Try again shortly.');
    this.name = 'StillPerformingError';
  }
}

export interface AccountHolderApprovalOptions {
  api: BotShieldApi;
  /** The agent name the Company registered in the Console, which heads the request on the person's phone. */
  agent: string;
  /** The key of the BotShield Action placed in the Console, such as `plan`. */
  actionKey: string;
  store?: Store<ApprovalRecord>;
  /** How long the person has to answer, 60–86400 seconds. Default 600. */
  ttlSeconds?: number;
  /** Seconds the Personal Agent waits between repeats. Default 5. */
  retryAfter?: number;
  /** Ask BotShield at most once per this many seconds per request, however often the agent repeats. Default 10. */
  checkEvery?: number;
}

export class AccountHolderApproval {
  private readonly store: Store<ApprovalRecord>;
  private readonly ttl: number;
  private readonly retryAfter: number;
  private readonly checkEvery: number;
  private readonly opts: AccountHolderApprovalOptions;

  constructor(opts: AccountHolderApprovalOptions) {
    this.opts = opts;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(opts.actionKey)) throw new Error('actionKey must be an action key, e.g. "plan"');
    this.store = opts.store ?? new MemoryStore<ApprovalRecord>();
    this.ttl = Math.min(86400, Math.max(60, opts.ttlSeconds ?? 600));
    this.retryAfter = opts.retryAfter ?? 5;
    this.checkEvery = (opts.checkEvery ?? 10) * 1000;
  }

  /**
   * Call on every request for an action that needs the account holder's approval.
   *
   * - `account`: the Company's own reference for the signed-in account (from the access token).
   * - `client`: the Personal Agent's `client_id`, so another Personal Agent can't use the approval.
   * - `approvalId`: from the `BotShield-Approval-Id` header or `_meta["botshield.ai/approval-id"]`.
   * - `meaning`: what the request asks for, as plain data, so a different request isn't matched.
   * - `summary`, `terms`: what the account holder reads. Every term that affects the action, and any total.
   */
  async require<T = unknown>(input: {
    account: string;
    client: string;
    approvalId?: string | null;
    meaning: unknown;
    summary: string;
    terms: TermRow[];
  }): Promise<RequireResult<T>> {
    checkTerms(input.terms);
    const digest = await sha256url(canonical({ meaning: input.meaning, summary: input.summary, terms: input.terms }));
    const lookup = `${input.account}\n${input.client}\n${digest}`;

    let rec = input.approvalId ? await this.store.get(input.approvalId) : null;
    if (rec && rec.lookup !== lookup) rec = null; // another account, client or request: a new one
    if (!rec) rec = await this.store.find(lookup);
    if (rec && (rec.state === 'declined' || rec.state === 'expired') && !input.approvalId) rec = null; // asked afresh
    if (!rec) return { approved: false, approval: toObject(await this.start(input, digest, lookup), this.retryAfter) };

    rec = await this.refresh(rec);
    if (rec.state === 'approved' || rec.state === 'performing' || rec.state === 'performed') {
      const id = rec.id;
      return { approved: true, approvalId: id, perform: (action) => this.performOnce<T>(id, action) };
    }
    return { approved: false, approval: toObject(rec, this.retryAfter) };
  }

  private async start(input: { account: string; client: string; summary: string; terms: TermRow[] }, digest: string, lookup: string): Promise<ApprovalRecord> {
    const id = newId('apv');
    const requestId = crypto.randomUUID();
    // Whole seconds, so the shared hash accepts it; BotShield's own clock decides the real expiry.
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + this.ttl * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const opHash = await operationHash({ operation_id: id, revision: digest, summary: input.summary, terms: { rows: input.terms }, expires_at: expiresAt });
    const act = `${this.opts.actionKey}:${opHash}`;
    let started: { expires_at: string };
    try {
      started = await this.opts.api.requestAction({
        requestId,
        agent: this.opts.agent,
        act,
        actLabel: input.summary.replace(/[*_`]/g, '').slice(0, 90),
        partnerUserRef: input.account,
        details: input.terms,
        ttlSeconds: this.ttl,
      });
    } catch (e) {
      if (e instanceof BotShieldError && e.code === 'not_linked') throw new NotLinkedError();
      throw e;
    }
    const rec: ApprovalRecord = {
      id, lookup, state: 'requested', account: input.account, client: input.client, digest, requestId, act,
      summary: input.summary, terms: input.terms, expiresAt: started.expires_at, operationHash: opHash,
    };
    await this.store.put(rec);
    return rec;
  }

  /** Read BotShield once for a request still waiting, and collect and check the token on approval. */
  private async refresh(rec: ApprovalRecord): Promise<ApprovalRecord> {
    if (rec.state !== 'requested') return rec;
    // However often the agent repeats, BotShield is asked at most once per `checkEvery`.
    if (rec.checkedAt && Date.now() - rec.checkedAt < this.checkEvery) return rec;
    const checked = { ...rec, checkedAt: Date.now() };
    let next: ApprovalRecord['state'] = 'requested';
    try {
      const s = await this.opts.api.actionStatus({ requestId: rec.requestId, agent: this.opts.agent });
      if (s.status === 'denied' || s.status === 'cancelled') next = 'declined';
      else if (s.status === 'expired') next = 'expired';
      else if (s.status === 'approved') {
        next = 'expired'; // approved, but the token can no longer be collected: treat as unanswered
        if (s.token) {
          const v = await this.opts.api.verifyToken({ token: s.token, expectedRequestId: rec.requestId });
          if (v.valid && v.verdict !== 'unavailable' && v.claims?.verified === true && v.claims.act === rec.act) next = 'approved';
        }
      } else if (new Date(s.expires_at).getTime() <= Date.now()) next = 'expired';
    } catch (e) {
      // Rate limited or unavailable: nothing is decided. Keep waiting; the next repeat asks again.
      if (isTransient(e)) {
        await this.store.swap(checked, 'requested');
        return checked;
      }
      throw e;
    }
    if (next === 'requested') {
      await this.store.swap(checked, 'requested');
      return checked;
    }
    const updated = { ...rec, state: next };
    if (await this.store.swap(updated, 'requested')) return updated;
    return (await this.store.get(rec.id)) ?? updated; // another request moved it first
  }

  private async performOnce<T>(id: string, action: () => Promise<T>): Promise<T> {
    const rec = await this.store.get(id);
    if (!rec) throw new Error('Unknown approval.');
    if (rec.state === 'performed') return rec.result as T;
    if (rec.state === 'performing') throw new StillPerformingError();
    if (rec.state !== 'approved') throw new Error(`Approval is ${rec.state}, not approved.`);
    if (!(await this.store.swap({ ...rec, state: 'performing' }, 'approved'))) return this.performOnce(id, action);
    let result: T;
    try {
      result = await action();
    } catch (e) {
      // The action failed. Back to approved, so a repeat can try again. If your action can fail
      // after taking effect, record that inside the action and make it idempotent on `id`.
      await this.store.swap({ ...rec, state: 'approved' }, 'performing');
      throw e;
    }
    await this.store.swap({ ...rec, state: 'performed', result }, 'performing');
    return result;
  }
}

/** A refusal that decides nothing about the request: rate limits and outages. */
export function isTransient(e: unknown): boolean {
  return e instanceof BotShieldError && (e.code === 'rate_limited' || e.code === 'unavailable' || e.status === 429 || e.status >= 500);
}

function toObject(rec: ApprovalRecord, retryAfter: number): ApprovalObject {
  const state: ApprovalState = rec.state === 'declined' || rec.state === 'expired' ? rec.state : rec.state === 'requested' ? 'requested' : 'approved';
  return {
    approval_id: rec.id,
    state,
    summary: rec.summary,
    terms: rec.terms,
    expires_at: rec.expiresAt,
    operation_hash: rec.operationHash,
    ...(state === 'requested' ? { retry_after: retryAfter } : {}),
  };
}

/** HTTP 403 for an API (SPEC section 5). */
export function approvalResponse(approval: ApprovalObject): { status: 403; headers: Record<string, string>; body: Record<string, unknown> } {
  const words: Record<ApprovalState, string> = {
    requested: 'The account holder has been asked to approve this in the BotShield app.',
    approved: 'The account holder approved this.',
    declined: 'The account holder declined this. It was not done.',
    expired: 'The account holder did not answer in time. It was not done.',
  };
  return {
    status: 403,
    headers: { 'Content-Type': 'application/json', ...(approval.state === 'requested' ? { 'Retry-After': String(approval.retry_after ?? 5) } : {}) },
    body: { error: 'account_holder_approval_required', error_description: words[approval.state], approval },
  };
}

/** An MCP tool error result that any MCP client can act on (SPEC section 5). */
export function approvalToolResult(approval: ApprovalObject): { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: { approval: ApprovalObject } } {
  const what = approval.summary.replace(/[*_`]/g, '');
  const text =
    approval.state === 'requested'
      ? `Not done yet. The account holder needs to approve this in the BotShield app on their phone: ${what}. Call this tool again after they approve.`
      : approval.state === 'declined'
        ? `Not done. The account holder declined: ${what}.`
        : `Not done. The account holder did not approve in time: ${what}.`;
  return { isError: true, content: [{ type: 'text', text }], structuredContent: { approval } };
}

/** The conversation message content (SPEC section 5). */
export function approvalMessageExtension(approval: ApprovalObject): Record<string, { approval: ApprovalObject }> {
  return { [APPROVAL_EXTENSION]: { approval } };
}

function checkTerms(terms: TermRow[]): void {
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > 12) throw new Error('terms: 1 to 12 rows.');
  for (const t of terms) {
    if (typeof t?.label !== 'string' || !t.label.trim() || t.label.length > 40) throw new Error('terms: each label is 1–40 characters.');
    if (typeof t?.value !== 'string' || !t.value.trim() || t.value.length > 80) throw new Error('terms: each value is 1–80 characters.');
  }
}

/** JSON with object keys sorted, so the same meaning always gives the same digest. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
