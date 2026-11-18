/**
 * The few BotShield calls a Company's server makes for these extensions. Server side only: every call
 * carries the Company's secret key (`bs_…`), which never reaches a Personal Agent or a browser.
 */

export interface BotShieldApiOptions {
  /** The Company's secret key, `bs_…`. For approvals it needs Gates API access (Console → API Keys). */
  secretKey: string;
  /** Default `https://api.botshield.ai`. */
  baseUrl?: string;
  /** For tests, or a runtime without a global fetch. */
  fetch?: typeof fetch;
}

/** A refusal from BotShield, with its `code` when it gave one. */
export class BotShieldError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'BotShieldError';
    this.status = status;
    this.code = code;
  }
}

export type ActionStatus = 'queued' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type CheckStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'not_found' | string;

export class BotShieldApi {
  private readonly base: string;
  private readonly key: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: BotShieldApiOptions) {
    if (!opts.secretKey?.startsWith('bs_')) throw new Error('secretKey must be a BotShield secret key (bs_…)');
    this.key = opts.secretKey;
    this.base = (opts.baseUrl ?? 'https://api.botshield.ai').replace(/\/+$/, '');
    // Called through a wrapper: Cloudflare Workers (and some browsers) throw "Illegal invocation" on an unbound global fetch.
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Ask the linked account holder to approve one act (BotShield Actions). */
  requestAction(input: {
    requestId: string;
    agent: string;
    act: string;
    actLabel?: string;
    partnerUserRef: string;
    details?: Array<{ label: string; value: string }>;
    ttlSeconds?: number;
  }): Promise<{ request_id: string; status: ActionStatus; expires_at: string }> {
    return this.call('POST', 'gates-api/actions/request', this.key, {
      request_id: input.requestId,
      agent: input.agent,
      act: input.act,
      ...(input.actLabel ? { act_label: input.actLabel } : {}),
      partner_user_ref: input.partnerUserRef,
      ...(input.details?.length ? { details: input.details } : {}),
      ...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
    });
  }

  /** Where an approval request stands. Once approved, `token` is there for a short window. */
  actionStatus(input: { requestId: string; agent: string; waitSeconds?: number }): Promise<{
    request_id: string;
    status: ActionStatus;
    act: string;
    expires_at: string;
    resolved_at: string | null;
    token?: string | null;
    token_expires_in?: number;
  }> {
    return this.call('GET', 'gates-api/actions/request-status', this.key, {
      request_id: input.requestId,
      agent: input.agent,
      ...(input.waitSeconds ? { wait_seconds: input.waitSeconds } : {}),
    });
  }

  /** Purchase gate: after the account holder approved the assistant, get BotShield's pairwise ID. */
  assistantRegister(input: { requestId: string; partnerUserRef: string; clientId: string; assistantUserId?: string | null }): Promise<{ pairwise_id: string; assistant_name: string; approved_at: string }> {
    return this.call('POST', 'gates-api/assistants/register', this.key, {
      request_id: input.requestId,
      partner_user_ref: input.partnerUserRef,
      assistant_client_id: input.clientId,
      ...(input.assistantUserId ? { assistant_user_id: input.assistantUserId } : {}),
    });
  }

  /** Purchase gate: the fresh check at checkout. */
  assistantCheck(input: { partnerUserRef: string; pairwiseId: string; clientId?: string | null; assistantUserId?: string | null; orderRef: string }): Promise<{ match: boolean; checked_at: string; check_id: string }> {
    return this.call('POST', 'gates-api/assistants/check', this.key, {
      partner_user_ref: input.partnerUserRef,
      pairwise_id: input.pairwiseId,
      ...(input.clientId ? { assistant_client_id: input.clientId } : {}),
      ...(input.assistantUserId ? { assistant_user_id: input.assistantUserId } : {}),
      order_ref: input.orderRef,
    });
  }

  /**
   * Open a presence check at one of the Company's Human Gates. With `partnerUserRef` on a gate whose
   * link setting is `required`, the same passkey tap links that account to BotShield, which is what
   * `botshield.ai/approval` needs first.
   */
  async startGateCheck(input: { gate: string; partnerUserRef?: string }): Promise<{
    request_id: string;
    web_url: string;
    qr_code_url: string;
    expires_at: string;
  }> {
    const ref = input.partnerUserRef ? { partner_user_id: input.partnerUserRef } : {};
    const grant = await this.call<{ anchor_grant_token?: string; session_token?: string }>('POST', 'sdk/create-session', this.key, ref);
    const grantToken = grant.anchor_grant_token ?? grant.session_token;
    if (!grantToken) throw new BotShieldError('BotShield did not return a grant token.', 502, null);
    return this.call('POST', 'sdk/create-verification-link', grantToken, {
      gate: input.gate,
      ...(input.partnerUserRef ? { partner_user_ref: input.partnerUserRef } : {}),
    });
  }

  /** A presence check's status. With the secret key, a passed check carries its token. */
  checkStatus(requestId: string): Promise<{
    found: boolean;
    status: CheckStatus;
    reason?: string | null;
    expires_at?: string;
    verification_token?: string | null;
    signed_token?: string | null;
  }> {
    return this.call('GET', 'verification/status', this.key, { request_id: requestId }, { raw: true });
  }

  /** Check a token once. BotShield refuses the same token a second time. */
  verifyToken(input: { token: string; expectedRequestId: string }): Promise<{
    valid: boolean;
    verdict?: 'pass' | 'unavailable';
    reason?: string;
    code?: string;
    claims?: { request_id: string; verified: boolean; act?: string; kind?: string | null; [k: string]: unknown };
  }> {
    return this.call('POST', 'sdk/verify-token', this.key, { token: input.token, expected_request_id: input.expectedRequestId });
  }

  private async call<T>(
    method: 'GET' | 'POST',
    op: string,
    bearer: string,
    payload: Record<string, unknown>,
    opts: { raw?: boolean } = {},
  ): Promise<T> {
    let url = `${this.base}/operations/${op}`;
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } };
    if (method === 'GET') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) if (v !== undefined) q.set(k, String(v));
      url += `?${q}`;
    } else {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    const res = await this.doFetch(url, init);
    const body = (await res.json().catch(() => null)) as unknown;
    // A gateway refusal (rate limit, auth) arrives as `{ errors: [...] }` with a 4xx.
    const gw = (body as { errors?: Array<{ message?: string; code?: string }> } | null)?.errors?.[0];
    if (gw) {
      const code = gw.code === 'RATE_LIMITED' ? 'rate_limited' : (gw.code ?? null);
      throw new BotShieldError(gw.message ?? `BotShield answered HTTP ${res.status}.`, res.status, code);
    }
    return unwrap<T>(body, res.status, opts.raw === true);
  }
}

/**
 * BotShield answers `{ data: … }`, sometimes nested once more, and reports a handler's refusal inside
 * `data.error` with HTTP 200. Unwrap to the payload, and throw on a refusal at any depth.
 */
export function unwrap<T>(body: unknown, httpStatus: number, raw = false): T {
  let cur: any = body;
  for (let depth = 0; depth < 3 && cur && typeof cur === 'object'; depth++) {
    if (cur.error && typeof cur.error === 'object') {
      const e = cur.error as { message?: string; statusCode?: number; code?: string };
      throw new BotShieldError(e.message ?? 'BotShield refused the request.', e.statusCode ?? httpStatus, e.code ?? null);
    }
    if (raw && !('data' in cur)) break;
    if (!('data' in cur)) break;
    cur = cur.data;
  }
  if (httpStatus >= 400) throw new BotShieldError(`BotShield answered HTTP ${httpStatus}.`, httpStatus, null);
  if (cur === null || cur === undefined) throw new BotShieldError('BotShield returned no data.', 502, null);
  return cur as T;
}
