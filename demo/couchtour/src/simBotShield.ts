/**
 * SIMULATED BotShield, for public visitors. Nothing here reaches BotShield.
 *
 * It stands in for `api.botshield.ai` behind the package's `BotShieldApi` (as its `fetch`), and
 * answers the same operations in the same envelope, so Couch Tour's code runs unchanged and the
 * inspector shows the whole flow. Its base URL is `https://sim.botshield.invalid`, so no request can
 * leave the Worker, and its tokens are signed by a demo key with the issuer
 * `https://sim.botshield.invalid`, which no real verifier accepts.
 *
 * The "BotShield app" is the second phone on the demo page: `/sim/phone` lists what waits for the
 * visitor and the agents they approved, `/sim/phone/answer` is their Confirm or "This isn't me",
 * and `/sim/phone/remove` removes an approved agent.
 */
import type { DemoStub } from './state.ts';
import { newEs256, randomId, signEs256, type Jwk } from './jose.ts';

export const SIM_BASE = 'https://sim.botshield.invalid';
export const SIM_KEY = 'bs_simulated_demo_key';
const ISS = SIM_BASE;

type Stub = DemoStub;

export type SimAction = {
  request_id: string; agent: string; act: string; act_label?: string; details?: Array<{ label: string; value: string }>;
  vh: string; status: 'queued' | 'approved' | 'denied' | 'expired'; expires_at: string; resolved_at: string | null;
  token: string | null; spent: boolean; chat?: string;
};
export type SimCheck = {
  request_id: string; gate: string; vh: string; status: 'pending' | 'completed' | 'failed' | 'expired'; reason: string | null;
  expires_at: string; token: string | null; spent: boolean; chat?: string;
};

/** An agent the account holder approved to buy at Couch Tour (the BotShield Signal API's record). */
export type SimAssistant = {
  pairwise_id: string; ref: string; client: string; user: string; name: string; vh: string; approved_at: string; removed: boolean; chat?: string;
};

async function simKey(stub: Stub): Promise<Jwk> {
  let k = await stub.kvGet<Jwk>('sim:signing-key');
  if (!k) {
    k = (await newEs256()).privateJwk;
    await stub.kvPut('sim:signing-key', k);
  }
  return k;
}

async function mint(stub: Stub, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signEs256({ typ: 'JWT', kid: 'simulated' }, { iss: ISS, aud: 'couchtour-demo', iat: now, exp: now + 300, verified: true, simulated: true, ...claims }, await simKey(stub));
}

/**
 * A `fetch` for `BotShieldApi` that answers as BotShield would. `vh` is the visitor this request is
 * for (from Couch Tour's signed-in account), so the visitor's simulated phone shows it.
 */
export function simBotShieldFetch(stub: Stub, ctx: { vh: string; chat?: string }): typeof fetch {
  const ok = (data: unknown) => new Response(JSON.stringify({ data: { data } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const refuse = (message: string, statusCode: number, code: string) =>
    new Response(JSON.stringify({ data: { error: { message, statusCode, code } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.origin !== SIM_BASE) throw new Error('The simulated BotShield only answers sim.botshield.invalid.');
    const op = u.pathname.replace('/operations/', '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    const q = u.searchParams;

    switch (op) {
      case 'gates-api/actions/request': {
        if (auth !== `Bearer ${SIM_KEY}`) return refuse('Invalid key.', 401, 'invalid_key');
        const expires = new Date(Date.now() + Math.min(86400, Number(body.ttl_seconds ?? 600)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const a: SimAction = {
          request_id: body.request_id, agent: body.agent, act: body.act, act_label: body.act_label, details: body.details,
          vh: ctx.vh, status: 'queued', expires_at: expires, resolved_at: null, token: null, spent: false, chat: ctx.chat,
        };
        await stub.kvPut(`sim:act:${a.request_id}`, a, 86400_000);
        await stub.kvPut(`sim:inbox:${ctx.vh}:act:${a.request_id}`, 1, 86400_000);
        return ok({ request_id: a.request_id, status: 'queued', expires_at: a.expires_at });
      }
      case 'gates-api/actions/request-status': {
        const a = await stub.kvGet<SimAction>(`sim:act:${q.get('request_id')}`);
        if (!a) return refuse('Not found.', 404, 'not_found');
        if (a.status === 'queued' && Date.parse(a.expires_at) < Date.now()) a.status = 'expired';
        return ok({
          request_id: a.request_id, status: a.status, act: a.act, expires_at: a.expires_at, resolved_at: a.resolved_at,
          ...(a.status === 'approved' ? { token: a.spent ? null : a.token, token_expires_in: a.spent ? 0 : 300 } : {}),
        });
      }
      case 'gates-api/assistants/register': {
        if (auth !== `Bearer ${SIM_KEY}`) return refuse('Invalid key.', 401, 'invalid_key');
        const a = await stub.kvGet<SimAction>(`sim:act:${body.request_id}`);
        if (!a || a.status !== 'approved' || !a.act.startsWith('assistant:')) return refuse('Not approved.', 404, 'not_approved');
        const pairwise = `BA_sim_${randomId('', 20)}`;
        const name = /^Let (.+) buy for you$/.exec(a.act_label ?? '')?.[1] ?? 'Your agent';
        const r: SimAssistant = {
          pairwise_id: pairwise, ref: String(body.partner_user_ref ?? ''), client: String(body.assistant_client_id ?? ''), user: String(body.assistant_user_id ?? ''),
          name, vh: a.vh, approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), removed: false, chat: a.chat,
        };
        await stub.kvPut(`sim:asst:${pairwise}`, r, 7 * 86400_000);
        await stub.kvPut(`sim:asstlist:${a.vh}:${pairwise}`, 1, 7 * 86400_000);
        return ok({ pairwise_id: pairwise, assistant_name: name, approved_at: r.approved_at });
      }
      case 'gates-api/assistants/check': {
        if (auth !== `Bearer ${SIM_KEY}`) return refuse('Invalid key.', 401, 'invalid_key');
        const r = await stub.kvGet<SimAssistant>(`sim:asst:${body.pairwise_id}`);
        // No match, with no reason (approval §9a step 3): removed, another account, or another agent.
        const match = !!r && !r.removed && r.ref === body.partner_user_ref && r.client === body.assistant_client_id && r.user === String(body.assistant_user_id ?? '');
        return ok({ match, checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), check_id: `chk_sim_${randomId('', 12)}` });
      }
      case 'sdk/create-session':
        return ok({ anchor_grant_token: `bss_sim_${randomId('', 9)}` });
      case 'sdk/create-verification-link': {
        if (!auth.startsWith('Bearer bss_sim_')) return refuse('Invalid grant.', 401, 'invalid_grant');
        const rid = `sim_${randomId('', 12)}`;
        const c: SimCheck = {
          request_id: rid, gate: body.gate, vh: ctx.vh, status: 'pending', reason: null,
          expires_at: new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), token: null, spent: false, chat: ctx.chat,
        };
        await stub.kvPut(`sim:chk:${rid}`, c, 86400_000);
        await stub.kvPut(`sim:inbox:${ctx.vh}:chk:${rid}`, 1, 86400_000);
        // The link has BotShield's real host, as the spec requires (section 5, step 2). It is never opened:
        // in this simulation, the second phone stands in for the BotShield app.
        return ok({ request_id: rid, web_url: `https://app.botshield.ai/verify?request_id=${rid}`, qr_code_url: `${SIM_BASE}/qr/${rid}`, expires_at: c.expires_at });
      }
      case 'verification/status': {
        const c = await stub.kvGet<SimCheck>(`sim:chk:${q.get('request_id')}`);
        if (!c) return new Response(JSON.stringify({ data: { found: false, status: 'not_found' } }), { status: 200 });
        return new Response(JSON.stringify({ data: { found: true, status: c.status, reason: c.reason, expires_at: c.expires_at, verification_token: c.status === 'completed' && !c.spent ? c.token : null } }), { status: 200 });
      }
      case 'sdk/verify-token': {
        const token = String(body.token ?? '');
        const rid = String(body.expected_request_id ?? '');
        const key = rid.startsWith('sim_') ? `sim:chk:${rid}` : `sim:act:${rid}`;
        const rec = await stub.kvGet<SimAction | SimCheck>(key);
        if (!rec || rec.token !== token) return ok({ valid: false, reason: 'unknown token' });
        if (rec.spent) return ok({ valid: false, replayed: true, reason: 'already used' });
        rec.spent = true;
        await stub.kvPut(key, rec, 86400_000);
        return ok({ valid: true, verdict: 'pass', claims: { request_id: rid, verified: true, ...('act' in rec ? { act: rec.act } : {}) } });
      }
      default:
        return refuse('Unknown operation.', 404, 'not_found');
    }
  }) as typeof fetch;
}

/** What waits on the visitor's simulated BotShield app. */
export async function phoneInbox(stub: Stub, vh: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const kind of ['act', 'chk'] as const) {
    // The inbox keys are few; list them through `since`-free scanning of known ids.
    const ids = await stub.kvList(`sim:inbox:${vh}:${kind}:`);
    for (const id of ids) {
      if (kind === 'act') {
        const a = await stub.kvGet<SimAction>(`sim:act:${id}`);
        if (a?.status === 'queued' && Date.parse(a.expires_at) > Date.now()) out.push({ kind: 'approval', request_id: a.request_id, title: a.act_label, details: a.details ?? [], expires_at: a.expires_at });
      } else {
        const c = await stub.kvGet<SimCheck>(`sim:chk:${id}`);
        if (c?.status === 'pending' && Date.parse(c.expires_at) > Date.now()) out.push({ kind: 'presence', request_id: c.request_id, title: 'Confirm with your passkey, for Couch Tour', details: [{ label: 'For', value: 'Rising Wave Live · Red Rocks presale' }], expires_at: c.expires_at });
      }
    }
  }
  return out;
}

/** The agents the visitor approved to buy at Couch Tour, as the BotShield app lists them. */
export async function phoneAgents(stub: Stub, vh: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const id of await stub.kvList(`sim:asstlist:${vh}:`)) {
    const r = await stub.kvGet<SimAssistant>(`sim:asst:${id}`);
    if (!r || r.removed) continue;
    let host = r.client;
    try { host = new URL(r.client).host; } catch { /* shown as it is */ }
    out.push({ pairwise_id: r.pairwise_id, name: r.name, from: host, company: 'Couch Tour (demo)', approved_at: r.approved_at });
  }
  return out;
}

/** The visitor removes an approved agent in the simulated BotShield app. Every check after this is no match. */
export async function phoneRemove(stub: Stub, vh: string, pairwiseId: string): Promise<{ ok: boolean; name?: string }> {
  const r = await stub.kvGet<SimAssistant>(`sim:asst:${pairwiseId}`);
  if (!r || r.vh !== vh || r.removed) return { ok: false };
  r.removed = true;
  await stub.kvPut(`sim:asst:${pairwiseId}`, r, 7 * 86400_000);
  await stub.kvDel(`sim:asstlist:${vh}:${pairwiseId}`);
  return { ok: true, name: r.name };
}

/** Removes every agent the visitor approved (the demo account's reset). */
export async function removeAllAgents(stub: Stub, vh: string): Promise<void> {
  for (const id of await stub.kvList(`sim:asstlist:${vh}:`)) await phoneRemove(stub, vh, id);
}

/** The visitor's answer on the simulated BotShield app. */
export async function phoneAnswer(stub: Stub, vh: string, input: { request_id: string; answer: 'confirm' | 'deny' }): Promise<{ ok: boolean; outcome?: string; chat?: string; kind?: string }> {
  if (input.request_id.startsWith('sim_')) {
    const c = await stub.kvGet<SimCheck>(`sim:chk:${input.request_id}`);
    if (!c || c.vh !== vh || c.status !== 'pending') return { ok: false };
    if (input.answer === 'deny') {
      c.status = 'failed';
      c.reason = 'declined';
    } else if (!(await stub.kvAdd(`sim:gate:${c.gate}:${vh}`, Date.now(), 86400_000))) {
      // The gate's rule: one pass per BotShield account at this gate. A second pass is refused.
      c.status = 'failed';
      c.reason = 'already_counted';
    } else {
      c.status = 'completed';
      c.token = await mint(stub, { request_id: c.request_id, gate: c.gate });
    }
    await stub.kvPut(`sim:chk:${c.request_id}`, c, 86400_000);
    await stub.kvDel(`sim:inbox:${vh}:chk:${c.request_id}`);
    return { ok: true, outcome: c.status === 'completed' ? 'passed' : c.reason ?? 'failed', chat: c.chat, kind: 'presence' };
  }
  const a = await stub.kvGet<SimAction>(`sim:act:${input.request_id}`);
  if (!a || a.vh !== vh || a.status !== 'queued') return { ok: false };
  a.status = input.answer === 'confirm' ? 'approved' : 'denied';
  a.resolved_at = new Date().toISOString();
  if (a.status === 'approved') a.token = await mint(stub, { request_id: a.request_id, act: a.act });
  await stub.kvPut(`sim:act:${a.request_id}`, a, 86400_000);
  await stub.kvDel(`sim:inbox:${vh}:act:${a.request_id}`);
  return { ok: true, outcome: a.status, chat: a.chat, kind: 'approval' };
}
