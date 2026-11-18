/**
 * `botshield.ai/human-presence` version 1, the Company's side. See extensions/human-presence/SPEC.md.
 *
 *   const presence = new HumanPresence({ api, gate: 'presale-dec-1' });
 *   const r = await presence.require({ session: { client, sid, user }, presenceId });
 *   if (!r.passed) return presenceResponse(r.presence);   // 403, the person is asked
 *   // a person was present, and the gate's per-person rule let them through
 */
import { BotShieldApi } from './api.ts';
import { isTransient } from './approval.ts';
import { PRESENCE_EXTENSION, newId } from './poppy.ts';
import { MemoryStore, type Store } from './store.ts';

export type PresenceState = 'requested' | 'passed' | 'refused' | 'expired';

/** The presence object the Personal Agent sees (SPEC section 4). */
export interface PresenceObject {
  presence_id: string;
  state: PresenceState;
  verification_uri?: string;
  qr_code_uri?: string;
  expires_at: string;
  retry_after?: number;
}

export interface PresenceRecord {
  id: string;
  lookup: string;
  state: PresenceState;
  requestId: string;
  verificationUri: string;
  qrCodeUri: string;
  expiresAt: string;
  passedAt?: number;
  /** When BotShield was last asked (ms), so repeats inside `checkEvery` don't call it again. */
  checkedAt?: number;
}

export interface HumanPresenceOptions {
  api: BotShieldApi;
  /** The key of a Human Gate placed in the Console. Its rule (e.g. one pass per person) applies. */
  gate: string;
  store?: Store<PresenceRecord>;
  /** How long a pass covers the Session, in seconds. Default 3600. */
  passFor?: number;
  retryAfter?: number;
  /** Ask BotShield at most once per this many seconds per check, however often the agent repeats. Default 10. */
  checkEvery?: number;
}

export class HumanPresence {
  private readonly store: Store<PresenceRecord>;
  private readonly passFor: number;
  private readonly retryAfter: number;
  private readonly checkEvery: number;
  private readonly opts: HumanPresenceOptions;

  constructor(opts: HumanPresenceOptions) {
    this.opts = opts;
    this.store = opts.store ?? new MemoryStore<PresenceRecord>();
    this.passFor = opts.passFor ?? 3600;
    this.retryAfter = opts.retryAfter ?? 5;
    this.checkEvery = (opts.checkEvery ?? 10) * 1000;
  }

  /**
   * Call on every request that needs a person. `session` is the verified Poppy Session
   * (`client_id`, `sid`, User ID, spec 5.3). `presenceId` is from the `BotShield-Presence-Id` header
   * or `_meta["botshield.ai/presence-id"]`.
   */
  async require(input: { session: { client: string; sid: string; user: string }; presenceId?: string | null }): Promise<{ passed: true } | { passed: false; presence: PresenceObject }> {
    const lookup = `${this.opts.gate}\n${input.session.client}\n${input.session.sid}\n${input.session.user}`;
    let rec = input.presenceId ? await this.store.get(input.presenceId) : null;
    if (rec && rec.lookup !== lookup) rec = null; // another Session's check
    if (!rec) rec = await this.store.find(lookup);

    if (rec?.state === 'passed' && rec.passedAt && Date.now() - rec.passedAt < this.passFor * 1000) return { passed: true };
    if (!rec || rec.state === 'passed' || ((rec.state === 'expired' || rec.state === 'refused') && !input.presenceId)) {
      rec = await this.start(lookup);
      return { passed: false, presence: toObject(rec, this.retryAfter) };
    }
    rec = await this.refresh(rec);
    return rec.state === 'passed' ? { passed: true } : { passed: false, presence: toObject(rec, this.retryAfter) };
  }

  private async start(lookup: string): Promise<PresenceRecord> {
    const c = await this.opts.api.startGateCheck({ gate: this.opts.gate });
    const rec: PresenceRecord = {
      id: newId('prs'), lookup, state: 'requested', requestId: c.request_id,
      verificationUri: c.web_url, qrCodeUri: c.qr_code_url, expiresAt: c.expires_at,
    };
    await this.store.put(rec);
    return rec;
  }

  private async refresh(rec: PresenceRecord): Promise<PresenceRecord> {
    if (rec.state !== 'requested') return rec;
    if (rec.checkedAt && Date.now() - rec.checkedAt < this.checkEvery) return rec;
    const checked = { ...rec, checkedAt: Date.now() };
    let s: Awaited<ReturnType<BotShieldApi['checkStatus']>>;
    try {
      s = await this.opts.api.checkStatus(rec.requestId);
    } catch (e) {
      if (isTransient(e)) {
        await this.store.swap(checked, 'requested');
        return checked;
      }
      throw e;
    }
    let next: PresenceState = 'requested';
    if (s.status === 'failed') next = 'refused';
    else if (s.status === 'expired' || s.status === 'not_found') next = 'expired';
    else if (s.status === 'completed') {
      next = 'refused';
      // BotShield returns the pass in one of two fields; it accepts one of them.
      try {
        for (const token of [s.verification_token, s.signed_token]) {
          if (!token) continue;
          const v = await this.opts.api.verifyToken({ token, expectedRequestId: rec.requestId });
          if (v.valid && v.verdict === 'pass' && v.claims?.verified === true) {
            next = 'passed';
            break;
          }
        }
      } catch (e) {
        if (!isTransient(e)) throw e;
        await this.store.swap(checked, 'requested');
        return checked;
      }
    } else if (new Date(rec.expiresAt).getTime() <= Date.now()) next = 'expired';
    if (next === 'requested') {
      await this.store.swap(checked, 'requested');
      return checked;
    }
    const updated: PresenceRecord = { ...rec, state: next, ...(next === 'passed' ? { passedAt: Date.now() } : {}) };
    if (await this.store.swap(updated, 'requested')) return updated;
    return (await this.store.get(rec.id)) ?? updated;
  }
}

function toObject(rec: PresenceRecord, retryAfter: number): PresenceObject {
  return {
    presence_id: rec.id,
    state: rec.state,
    ...(rec.state === 'requested' ? { verification_uri: rec.verificationUri, qr_code_uri: rec.qrCodeUri, retry_after: retryAfter } : {}),
    expires_at: rec.expiresAt,
  };
}

/** HTTP 403 for an API (SPEC section 4). */
export function presenceResponse(presence: PresenceObject): { status: 403; headers: Record<string, string>; body: Record<string, unknown> } {
  const words: Record<PresenceState, string> = {
    requested: 'A person needs to confirm in the BotShield app. Open the link on your phone.',
    passed: 'A person confirmed.',
    refused: 'This was not allowed. It was not done.',
    expired: 'Nobody confirmed in time. It was not done.',
  };
  return {
    status: 403,
    headers: { 'Content-Type': 'application/json', ...(presence.state === 'requested' ? { 'Retry-After': String(presence.retry_after ?? 5) } : {}) },
    body: { error: 'human_presence_required', error_description: words[presence.state], presence },
  };
}

/** An MCP tool error result that any MCP client can act on (SPEC section 4). */
export function presenceToolResult(presence: PresenceObject): { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: { presence: PresenceObject } } {
  const text =
    presence.state === 'requested'
      ? `Not done yet. A person needs to confirm in the BotShield app: open ${presence.verification_uri} on your phone, then call this tool again.`
      : presence.state === 'refused'
        ? 'Not done. This was not allowed.'
        : 'Not done. Nobody confirmed in time.';
  return { isError: true, content: [{ type: 'text', text }], structuredContent: { presence } };
}

export function presenceMessageExtension(presence: PresenceObject): Record<string, { presence: PresenceObject }> {
  return { [PRESENCE_EXTENSION]: { presence } };
}

/** The Personal Agent's host check (SPEC section 5, step 2). Exported for agent builders. */
export function trustedPresenceLinks(p: Pick<PresenceObject, 'verification_uri' | 'qr_code_uri'>): boolean {
  const host = (u?: string) => {
    try {
      const url = new URL(u ?? '');
      return url.protocol === 'https:' ? url.host : null;
    } catch {
      return null;
    }
  };
  if (host(p.verification_uri) !== 'app.botshield.ai') return false;
  return p.qr_code_uri === undefined || host(p.qr_code_uri) === 'api.botshield.ai';
}
