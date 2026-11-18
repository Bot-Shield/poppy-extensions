/**
 * A fake BotShield for tests. It answers in the envelope the real API uses: `{ data: { data: … } }`
 * for a payload, `{ data: { error: { … } } }` at HTTP 200 for a refusal, and `{ data: … }` for
 * verification/status.
 */
export interface FakeState {
  linked: boolean;
  action?: { request_id: string; act: string; status: string; expires_at: string; token: string | null; spent: boolean };
  check?: { request_id: string; status: string; reason: string | null; token: string | null; spent: boolean };
  calls: string[];
  /** When set, every call is refused the way BotShield's gateway refuses a key over its limit. */
  rateLimited?: boolean;
  /** Purchase gate: registered approvals by pairwise ID, and whether the person removed them. */
  assistants?: Map<string, { ref: string; act: string; removed: boolean }>;
  checks?: number;
}

export function fakeBotShield(state: FakeState): typeof fetch {
  const ok = (data: unknown) => new Response(JSON.stringify({ data: { data } }), { status: 200 });
  const refuse = (message: string, statusCode: number, code: string) =>
    new Response(JSON.stringify({ data: { error: { message, statusCode, code } } }), { status: 200 });

  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const op = u.pathname.replace('/operations/', '');
    state.calls.push(op);
    if (state.rateLimited) {
      return new Response(JSON.stringify({ errors: [{ message: 'Development key limit reached (hourly)', code: 'RATE_LIMITED' }] }), { status: 403 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = new Headers(init?.headers).get('Authorization') ?? '';

    switch (op) {
      case 'gates-api/actions/request':
        if (!auth.startsWith('Bearer bs_')) return refuse('key', 401, 'invalid_key');
        if (!state.linked) return refuse('not linked', 409, 'not_linked');
        state.action = { request_id: body.request_id, act: body.act, status: 'queued', expires_at: new Date(Date.now() + 600_000).toISOString(), token: null, spent: false };
        return ok({ request_id: body.request_id, status: 'queued', expires_at: state.action.expires_at });
      case 'gates-api/actions/request-status': {
        const a = state.action!;
        return ok({ request_id: a.request_id, status: a.status, act: a.act, expires_at: a.expires_at, resolved_at: a.status === 'queued' ? null : new Date().toISOString(), ...(a.status === 'approved' ? { token: a.token, token_expires_in: a.token ? 300 : 0 } : {}) });
      }
      case 'gates-api/assistants/register': {
        const a = state.action;
        if (!a || a.status !== 'approved' || a.request_id !== body.request_id) return refuse('no', 404, 'not_approved');
        state.assistants ??= new Map();
        const pairwise = `BA_${'x'.repeat(29)}${state.assistants.size.toString().padStart(3, '0')}`;
        state.assistants.set(pairwise, { ref: body.partner_user_ref, act: a.act, removed: false });
        return ok({ pairwise_id: pairwise, assistant_name: 'Example Agent', approved_at: new Date().toISOString() });
      }
      case 'gates-api/assistants/check': {
        state.checks = (state.checks ?? 0) + 1;
        const r = state.assistants?.get(body.pairwise_id);
        const match = !!r && !r.removed && r.ref === body.partner_user_ref;
        return ok({ match, checked_at: new Date().toISOString(), check_id: `chk_${state.checks}` });
      }
      case 'sdk/create-session':
        return ok({ anchor_grant_token: 'bss_grant', session_token: 'bss_grant' });
      case 'sdk/create-verification-link':
        if (auth !== 'Bearer bss_grant') return refuse('grant', 401, 'invalid_grant');
        state.check = { request_id: 'req-1', status: 'pending', reason: null, token: null, spent: false };
        return ok({ request_id: 'req-1', web_url: 'https://app.botshield.ai/verify?request_id=req-1', qr_code_url: 'https://api.botshield.ai/qr/req-1', expires_at: new Date(Date.now() + 600_000).toISOString() });
      case 'verification/status': {
        const c = state.check!;
        return new Response(JSON.stringify({ data: { found: true, status: c.status, reason: c.reason, verification_token: c.status === 'completed' ? c.token : null } }), { status: 200 });
      }
      case 'sdk/verify-token': {
        const holder = state.action?.token === body.token ? state.action : state.check?.token === body.token ? state.check : null;
        if (!holder) return ok({ valid: false, reason: 'unknown token' });
        if (holder.spent) return ok({ valid: false, replayed: true, reason: 'already used' });
        if (holder.request_id !== body.expected_request_id) return ok({ valid: false, code: 'request_mismatch' });
        holder.spent = true;
        return ok({ valid: true, verdict: 'pass', claims: { request_id: holder.request_id, verified: true, ...('act' in holder ? { act: holder.act } : {}) } });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
}
