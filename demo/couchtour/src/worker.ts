/**
 * Couch Tour · Poppy demo. One Worker plays three parts, kept apart in code:
 *
 *   company.ts       Couch Tour (demo), a Poppy Company: discovery, sign-in, Sessions, APIs, a Company Agent
 *   agent.ts         a Personal Agent driven by Claude, making real Poppy requests to Couch Tour
 *   simBotShield.ts  a SIMULATED BotShield for public visitors (live mode, with the demo key, uses the real one)
 *
 * and the page at `/` shows the traffic between them, Atlas-style.
 *
 * /mcp is a remote MCP server for ChatGPT and Claude connectors: OAuth 2.1 at this Company's own
 * sign-in (MCP authorization), and buying tickets on the BotShield Signal API in 'ask' mode. With the
 * demo key instead of a token it keeps the first demo's tools.
 *
 * Routes kept from the first demo: POST /api/refunds and
 * POST /api/presale/enter without a Poppy-Session (needs the demo key: live), GET /api/trace,
 * /api/admin/link*, POST /api/reset.
 *
 * Nothing here touches Couch Tour's production service.
 */
import { BotShieldApi, AssistantGate, APPROVAL_ID_HEADER, PRESENCE_ID_HEADER, APPROVAL_ID_META, PRESENCE_ID_META, approvalToolResult, presenceToolResult } from '../../../packages/poppy/src/index.ts';
import { DemoState, doStore } from './state.ts';
import { demoPage } from './page.ts';
import { setLocalHandler } from './net.ts';
import { Collector } from './trace.ts';
import {
  accountFor, authServerMetadata, authorize, asHttp, bearerAccess, changePhone, companyApi, connectorAccount, connectorOrder, deps, enterPresale, json, liveAllowed, mcpProtectedResource, mcpResourceMetadataUrl, openApi, placeOrder, poppyJson, protectedResource, refund, showsList, stubOf, visitorHash,
  CONNECTOR_SCOPES, PRESENTER_ACCOUNT, type Access, type Outcome,
} from './company.ts';
import { agentJwks, clientMetadata, events, loadCtx, poll, resumeAfterSignIn, signInCallback, signInWithPhone, signOut, startChat, userMessage, validChatId, type AgentEnv } from './agent.ts';
import { phoneAgents, phoneAnswer, phoneInbox, phoneRemove, removeAllAgents } from './simBotShield.ts';

export { DemoState };

export interface Env extends AgentEnv {
  DEMO_LINK_GATE: string;
  DEMO_ADMIN_TOKEN?: string;
}

const CHATS_PER_HOUR = 20;
const VALIDATOR = 'https://poppydemoagent.dev/validator/api';

const pub = (body: unknown) => json(body, 200, { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
const html = (body: string, cache = 'no-store') => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache } });
const validVid = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  // HEAD is answered as GET for the public documents and the page (the runtime drops the body).
  const GET = req.method === 'GET' || req.method === 'HEAD';

  // Discovery (spec 3, 3.2, 7) and the agent's own documents (spec 4.1).
  if (GET && path === '/.well-known/poppy.json') return pub(poppyJson(env));
  if (GET && path === '/.well-known/oauth-protected-resource') return pub(protectedResource(env));
  if (GET && path === '/.well-known/oauth-protected-resource/mcp') return pub(mcpProtectedResource(env));
  if (GET && path === '/.well-known/oauth-authorization-server') return pub(authServerMetadata(env));
  if (GET && path === '/openapi.json') return pub(openApi(env));
  if (GET && path === '/agent/client.json') return pub(clientMetadata(env));
  if (GET && path === '/agent/jwks.json') return pub(await agentJwks(env));

  if (path === '/oauth/authorize' && (GET || req.method === 'POST')) return authorize(req, env);
  const company = await companyApi(req, env);
  if (company) return company;

  // The agent's sign-in redirect lands here, inside the page's sign-in sheet.
  if (GET && path === '/agent/callback') {
    const r = await signInCallback(env, url);
    return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title><body style="font:15px system-ui;padding:24px">${r.message}<script>parent.postMessage({type:'signin-done',chat:${JSON.stringify(r.chat)},ok:${r.ok}},location.origin)</script>`);
  }

  // The page's calls to its agent.
  const m = /^\/agent\/chat\/([^/]+)\/(start|message|resume|poll|signout|signin-phone|events|unknown-agent)$/.exec(path);
  if (m) return chatRoute(req, env, m[1], m[2]);
  if (req.method === 'POST' && path === '/agent/reset') {
    const b = (await req.json().catch(() => ({}))) as { vid?: string };
    if (!validVid(b.vid)) return json({ error: 'bad_request' }, 400);
    const vh = await visitorHash(b.vid);
    const stub = stubOf(env);
    for (const k of [`vtok:${vh}`, `acct:fan_${vh}`]) await stub.kvDel(k);
    await stub.kvDelPrefix(`sim:inbox:${vh}:`);
    await removeAllAgents(stub, vh);
    for (const g of await stub.kvList('sim:gate:')) if (g.endsWith(`:${vh}`)) await stub.kvDel(`sim:gate:${g}`);
    return json({ reset: true });
  }

  // The simulated BotShield app (the second phone).
  if (GET && path === '/sim/phone') {
    const vid = url.searchParams.get('vid');
    if (!validVid(vid)) return json({ error: 'bad_request' }, 400);
    const vh = await visitorHash(vid);
    return json({ items: await phoneInbox(stubOf(env), vh), agents: await phoneAgents(stubOf(env), vh) });
  }
  if (req.method === 'POST' && path === '/sim/phone/remove') {
    const b = (await req.json().catch(() => ({}))) as { vid?: string; pairwise_id?: string; chat?: string };
    if (!validVid(b.vid) || typeof b.pairwise_id !== 'string') return json({ error: 'bad_request' }, 400);
    const r = await phoneRemove(stubOf(env), await visitorHash(b.vid), b.pairwise_id);
    if (r.ok && typeof b.chat === 'string' && validChatId(b.chat)) {
      await stubOf(env).append(`ev:${b.chat}`, { kind: 'row', lane: 'phone', title: `The account holder removes ${r.name} in the BotShield app`, result: 'Every check after this is no match', simulated: true, tags: [{ s: 'approval § 9a', ext: 'approval' }], agentNotes: ['Simulated: in the real flow this happens in the BotShield app, on the account holder\'s own phone.', 'Couch Tour isn\'t told. Its next BotShield Signal API check comes back no match (approval §9a step 4).'] });
    }
    return json({ ok: r.ok });
  }
  if (req.method === 'POST' && path === '/sim/phone/answer') {
    const b = (await req.json().catch(() => ({}))) as { vid?: string; request_id?: string; answer?: string };
    if (!validVid(b.vid) || typeof b.request_id !== 'string' || (b.answer !== 'confirm' && b.answer !== 'deny')) return json({ error: 'bad_request' }, 400);
    const r = await phoneAnswer(stubOf(env), await visitorHash(b.vid), { request_id: b.request_id, answer: b.answer });
    if (r.ok && r.chat && validChatId(r.chat)) {
      const approval = r.kind === 'approval';
      const title = approval
        ? (r.outcome === 'approved' ? 'The account holder approves, with their passkey' : 'The account holder taps "This isn\'t me"')
        : (b.answer === 'confirm' ? 'The account holder confirms, with their passkey' : 'The account holder declines');
      const result = approval ? (r.outcome === 'approved' ? 'BotShield signs the approval for Couch Tour' : 'Declined') : r.outcome === 'passed' ? 'BotShield signs the answer for Couch Tour' : r.outcome === 'already_counted' ? 'Refused at the gate' : 'Declined';
      await stubOf(env).append(`ev:${r.chat}`, { kind: 'row', lane: 'phone', title, result, simulated: true, tags: [{ s: approval ? 'approval § 8' : 'presence § 7', ext: approval ? 'approval' : 'presence' }], agentNotes: ['Simulated: in the real flow this happens in the BotShield app, on the account holder\'s own phone.'] });
    }
    return json({ ok: r.ok, outcome: r.outcome ?? null });
  }

  // "Validated against Poppy Draft 1.0": the public validator's verdict on this host, cached 5 minutes.
  if (GET && path === '/api/validate') {
    const stub = stubOf(env);
    const cached = await stub.kvGet<unknown>('validator');
    if (cached && !url.searchParams.has('fresh')) return json(cached);
    const res = await fetch(VALIDATOR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: env.DEMO_HOST }) });
    const body = { checked_at: new Date().toISOString(), validator: VALIDATOR, status: res.status, result: await res.json().catch(() => null) };
    if (res.ok) await stub.kvPut('validator', body, 300_000);
    return json(body);
  }

  if (path === '/mcp') return withCors(await mcpRoute(req, env));

  // ── Kept from the first demo ─────────────────────────────────────────────────────────────────
  const legacy = path === '/api/refunds' || path === '/api/presale/enter' || path === '/api/trace';
  if (legacy && !liveAllowed(req, env)) {
    return json({ error: 'demo_key_required', error_description: 'Live calls reach the presenter\'s phone. Try the simulated demo at /.' }, 401);
  }
  if (req.method === 'POST' && path === '/api/refunds') {
    const body = (await req.json().catch(() => ({}))) as { to_card_last4?: string };
    const c = new Collector();
    const o = await refund(env, deps(env, true, c, { vh: 'legacy' }), c, { account: 'fan_legacy', client: req.headers.get('X-Demo-Client') ?? 'https://agent.example/agent.json', toCardLast4: String(body.to_card_last4 ?? ''), approvalId: req.headers.get(APPROVAL_ID_HEADER) });
    await legacyTrace(env, 'refund', c, o);
    return asHttp(o);
  }
  if (req.method === 'POST' && path === '/api/presale/enter') {
    const c = new Collector();
    const session = { client: req.headers.get('X-Demo-Client') ?? 'https://agent.example/agent.json', sid: req.headers.get('X-Demo-Sid') ?? 'demo-sid', user: req.headers.get('X-Demo-User') ?? 'usr_demo' };
    const o = await enterPresale(env, deps(env, true, c, { vh: 'legacy' }), c, { account: `fan_legacy_${session.user}`, session, presenceId: req.headers.get(PRESENCE_ID_HEADER) });
    await legacyTrace(env, 'presale', c, o);
    return asHttp(o);
  }
  if (GET && path === '/api/trace') return json(await stubOf(env).traces());
  if (path.startsWith('/api/admin/link')) {
    if (!env.DEMO_ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.DEMO_ADMIN_TOKEN}`) return json({ error: 'forbidden' }, 403);
    const api = new BotShieldApi({ secretKey: env.BOTSHIELD_SECRET_KEY, baseUrl: env.BOTSHIELD_API_URL });
    if (req.method === 'POST' && path === '/api/admin/link') {
      const c = await api.startGateCheck({ gate: env.DEMO_LINK_GATE, partnerUserRef: env.DEMO_ACCOUNT_REF });
      return json({ request_id: c.request_id, verification_uri: c.web_url, expires_at: c.expires_at });
    }
    const rid = url.searchParams.get('request_id');
    if (req.method === 'POST' && path === '/api/admin/link/confirm' && rid) return json({ link: await api.confirmLink({ requestId: rid, partnerUserRef: env.DEMO_ACCOUNT_REF }) });
  }
  // Admin only: the BotShield Signal API for any assistant client_id on the linked demo account, in 'ask'
  // mode (Loop 190 day-1 test: client_id https://chatgpt.com/oauth/client.json). Body: { client_id, approval_id? }.
  if (req.method === 'POST' && path === '/api/admin/assistant-check') {
    if (!env.DEMO_ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.DEMO_ADMIN_TOKEN}`) return json({ error: 'forbidden' }, 403);
    const b = (await req.json().catch(() => ({}))) as { client_id?: string; approval_id?: string | null };
    if (!b.client_id) return json({ error: 'client_id required' }, 400);
    const api = new BotShieldApi({ secretKey: env.BOTSHIELD_SECRET_KEY, baseUrl: env.BOTSHIELD_API_URL });
    const gate = new AssistantGate({ api, agent: env.DEMO_AGENT_NAME, store: doStore(stubOf(env), 'admin-assistant'), checkEvery: 0 });
    const r: any = await gate.require({ account: env.DEMO_ACCOUNT_REF, assistant: { clientId: b.client_id }, orderRef: `ord_${Date.now()}`, approvalId: b.approval_id ?? null });
    return json({ allowed: r.allowed, match: r.match ?? null, refused: r.refused ?? null, approval: r.approval ? { approval_id: r.approval.approval_id, state: r.approval.state, summary: r.approval.summary } : null });
  }
  if (req.method === 'POST' && path === '/api/reset') {
    if (!env.DEMO_ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.DEMO_ADMIN_TOKEN}`) return json({ error: 'forbidden' }, 403);
    await stubOf(env).reset();
    return json({ reset: true });
  }

  if (GET && (path === '/' || path === '/index.html')) return html(demoPage(), 'public, max-age=60');
  return json({ error: 'not_found' }, 404);
}

async function legacyTrace(env: Env, flow: string, c: Collector, o: Outcome) {
  const stub = stubOf(env);
  const at = new Date().toISOString();
  for (const n of c.notes) await stub.trace({ at, flow, lane: 'company', title: n });
  await stub.trace({ at, flow, lane: 'company', title: o.done ? 'Done' : 'approval' in o ? `Approval: ${o.approval.state}` : 'presence' in o ? `Presence: ${o.presence.state}` : `Not done: ${o.error}` });
}

async function chatRoute(req: Request, env: Env, id: string, action: string): Promise<Response> {
  if (!validChatId(id)) return json({ error: 'bad_chat_id' }, 400);
  if (action === 'events') {
    if (req.method !== 'GET') return json({ error: 'method' }, 405);
    return json({ events: await events(env, id, Number(new URL(req.url).searchParams.get('after') ?? 0) || 0) });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const stub = stubOf(env);
  const body = (await req.json().catch(() => ({}))) as { vid?: string; text?: string; key?: string; phone?: string };
  // One run at a time per chat.
  if (!(await stub.kvAdd(`busy:${id}`, 1, 120_000))) return json({ error: 'busy' }, 409);
  try {
    if (action === 'start') {
      if (!validVid(body.vid)) return json({ error: 'bad_request' }, 400);
      const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
      const rl = await stub.hit(`rl:${await visitorHash(ip)}`, CHATS_PER_HOUR, 3600_000);
      if (!rl.ok) return json({ error: 'rate_limited', error_description: `This demo allows ${CHATS_PER_HOUR} sessions an hour from one network. Try again later.` }, 429, { 'Retry-After': '600' });
      const live = !!env.DEMO_LIVE_KEY && body.key === env.DEMO_LIVE_KEY;
      if (body.key && !live) return json({ error: 'demo_key_invalid' }, 401);
      const ctx = await startChat(env, id, body.vid, live);
      return json({ ok: true, mode: ctx.chat.mode });
    }
    const ctx = await loadCtx(env, id);
    if (!ctx) return json({ error: 'no_chat' }, 404);
    if (action === 'message') {
      const text = String(body.text ?? '').trim().slice(0, 500);
      if (!text) return json({ error: 'empty' }, 400);
      await userMessage(ctx, text);
      return json({ ok: true, pending: !!ctx.chat.pending });
    }
    if (action === 'resume') { await resumeAfterSignIn(ctx); return json({ ok: true, pending: !!ctx.chat.pending }); }
    if (action === 'poll') return json(await poll(ctx));
    if (action === 'signin-phone') {
      const phone = String(body.phone ?? '').slice(0, 32);
      if (!(await signInWithPhone(ctx, phone))) return json({ ok: false, error: 'sign_in_failed' });
      await resumeAfterSignIn(ctx);
      return json({ ok: true, pending: !!ctx.chat.pending });
    }
    if (action === 'signout') { await signOut(ctx); return json({ ok: true }); }
    if (action === 'unknown-agent') { await unknownAgentOrder(env, ctx); return json({ ok: true }); }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    console.error('[chat]', action, e instanceof Error ? e.message : String(e));
    await stub.append(`ev:${id}`, { kind: 'say', role: 'system', text: 'Something went wrong in the demo. Start a new session to try again.' });
    return json({ error: 'server_error' }, 500);
  } finally {
    await stub.kvDel(`busy:${id}`);
  }
}

/**
 * Debug: an agent Couch Tour has never seen tries to buy on this visitor's account. It isn't signed
 * in by the account holder, so Couch Tour won't ask them; the BotShield Signal API has no approval
 * for it, so the answer is no match, and nobody is asked.
 */
async function unknownAgentOrder(env: Env, ctx: NonNullable<Awaited<ReturnType<typeof loadCtx>>>) {
  const c = new Collector();
  const account = accountFor(ctx.chat.vh);
  const d = deps(env, ctx.chat.mode === 'live', c, { vh: ctx.chat.vh, chat: ctx.chat.id });
  const assistant = { clientId: 'https://unknown-agent.example/agent.json', userId: 'usr_unknown' };
  const o = await placeOrder(env, d, c, { account, assistant, quantity: 2, approvalId: null, mayAsk: false });
  const res = asHttp(o);
  const body = await res.json().catch(() => null);
  await ctx.emit({ kind: 'group', title: 'Debug: an unknown agent tries to buy two tickets' });
  await ctx.emit({
    kind: 'row', lane: 'poppy', title: 'Buy tickets, as an agent Couch Tour has never seen', result: o.done ? 'Ordered' : 'Declined. Not done',
    tags: [{ s: 'approval § 9a', ext: 'approval' }], rtags: [{ s: 'approval § 9a', ext: 'approval' }],
    agentNotes: [`Simulated from the Debug menu: ${assistant.clientId} orders on this account. It isn't the agent in the chat, and the account holder never signed it in.`],
    companyNotes: c.notes, req: { method: 'POST', url: `https://${env.DEMO_HOST}/api/orders`, body: { quantity: 2 } }, res: { status: res.status, body },
  });
  for (const call of c.calls) await ctx.emit(call);
}

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    setLocalHandler((r) => handle(r, env));
    try {
      return await handle(req, env);
    } catch (e) {
      console.error('[demo]', e instanceof Error ? e.message : String(e));
      return json({ error: 'server_error' }, 500);
    }
  },
};
export default handler;

// ── MCP (Streamable HTTP, JSON responses, legacy-era protocol with initialize) ──────────────────────
//
// Two ways in:
// - a connector (ChatGPT, Claude): `Authorization: Bearer` with an access token from this Company's
//   own sign-in (MCP authorization: RFC 9728 metadata, OAuth 2.1 with PKCE, Client ID Metadata
//   Documents). Without one it answers 401 with the resource metadata pointer, which starts sign-in.
// - the first demo: `X-Demo-Key`, with its refund, presale and phone tools.

/** Protocol versions answered. 2026-07-28 and later (no initialize) get a 400 that isn't a modern error, so dual-era clients fall back to initialize. */
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Demo-Key',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

function challenge(env: Env, status: 401 | 403, error?: 'invalid_token' | 'insufficient_scope', scope = CONNECTOR_SCOPES.join(' '), description?: string): Response {
  const parts = [`resource_metadata="${mcpResourceMetadataUrl(env)}"`, `scope="${scope}"`];
  if (error) parts.unshift(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return json({ error: error ?? 'unauthorized', error_description: description ?? 'Sign in to Couch Tour to use this connector.' }, status, { 'WWW-Authenticate': `Bearer ${parts.join(', ')}` });
}

async function mcpRoute(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (liveAllowed(req, env)) return mcp(req, env, null);
  const { token, access } = await bearerAccess(env, req);
  if (!token) return challenge(env, 401);
  if (!access) return challenge(env, 401, 'invalid_token', undefined, 'The access token is expired, revoked or unknown.');
  if (access.account !== PRESENTER_ACCOUNT) return challenge(env, 401, 'invalid_token', undefined, 'This token is for the simulated web demo. Sign in again.');
  return mcp(req, env, access);
}

const TOOLS = [
  {
    name: 'request_refund',
    description:
      'Refund the customer\'s 2 tickets for Rising Wave Live · Red Rocks (Fri, Dec 5) to a card. ' +
      'A refund to a different card than the one paid with needs the account holder\'s approval in the BotShield app on their phone; ' +
      'if the result says so, tell the user to approve there, then call this tool again with the approval_id.',
    inputSchema: { type: 'object', properties: { to_card_last4: { type: 'string', description: 'Last four digits of the card to refund to.' }, approval_id: { type: 'string', description: 'From an earlier result, when repeating the request.' } }, required: ['to_card_last4'] },
  },
  {
    name: 'enter_presale',
    description: 'Enter the customer in the presale for Rising Wave Live · Red Rocks. BotShield confirms the account holder with their passkey. If the result has a link, show it to the user to confirm in the BotShield app, then call this tool again with the presence_id.',
    inputSchema: { type: 'object', properties: { presence_id: { type: 'string', description: 'From an earlier result, when repeating the request.' } } },
  },
  {
    name: 'update_phone',
    description: 'Change the phone number on the customer\'s Couch Tour account. It needs the account holder\'s approval in the BotShield app on their phone; if the result says so, tell the user to approve there, then call this tool again with the same number and the approval_id.',
    inputSchema: { type: 'object', properties: { phone_number: { type: 'string', description: 'The new number, e.g. "303 555 0141".' }, approval_id: { type: 'string', description: 'From an earlier result, when repeating the request.' } }, required: ['phone_number'] },
  },
];

/** The connector's tools. */
const CONNECTOR_TOOLS = [
  {
    name: 'find_shows',
    title: 'Find shows',
    description: 'Upcoming Couch Tour shows: artist, venue, date and time, doors, and whether tickets are on sale. With no query, the whole calendar, soonest first; the first one is the next show.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional: an artist, venue or city to search for.' } } },
    annotations: { title: 'Find shows', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'buy_tickets',
    title: 'Buy tickets',
    description:
      'Buy tickets to Rising Wave Live · Red Rocks (Fri, Dec 5, 2026), $48 each, on the signed-in Couch Tour account. ' +
      'Couch Tour checks each purchase with BotShield. The first purchase by this assistant needs the account holder\'s approval in the BotShield app on their phone: ' +
      'if the result says so, tell the user to approve there, then call this tool again with the same quantity and the approval_id.',
    inputSchema: {
      type: 'object',
      properties: {
        quantity: { type: 'integer', minimum: 1, maximum: 8, description: 'How many tickets, 1 to 8.' },
        approval_id: { type: 'string', description: 'From an earlier result, when repeating the purchase after the account holder approved.' },
      },
      required: ['quantity'],
    },
    annotations: { title: 'Buy tickets', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_account',
    title: 'Your Couch Tour account',
    description: 'The signed-in Couch Tour account: its tickets, and the phone number on file (last two digits).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Your Couch Tour account', readOnlyHint: true, openWorldHint: false },
  },
];

const textResult = (data: Record<string, unknown>, text = JSON.stringify(data)) => ({ content: [{ type: 'text', text }], structuredContent: data });

async function mcp(req: Request, env: Env, access: Access | null): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const msg = (await req.json().catch(() => null)) as { id?: unknown; method?: string; params?: any } | null;
  if (!msg || typeof msg.method !== 'string') return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });
  const version = req.headers.get('MCP-Protocol-Version');
  if (msg.method !== 'initialize' && version && !MCP_VERSIONS.includes(version)) {
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `This server speaks MCP ${MCP_VERSIONS.join(', ')}. Start with initialize.` } }, 400);
  }
  const mcpSession = req.headers.get('Mcp-Session-Id') ?? 'mcp';
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0];
      const instructions = access
        ? 'Couch Tour (a demo): find shows, see the signed-in account, and buy tickets. Couch Tour checks each purchase with BotShield; the first one by you needs the account holder\'s approval in the BotShield app.'
        : undefined;
      return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'couchtour-poppy-demo', title: 'Couch Tour (demo)', version: '0.3.0' }, ...(instructions ? { instructions } : {}) } }, 200, { 'Mcp-Session-Id': crypto.randomUUID() });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: access ? CONNECTOR_TOOLS : TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const meta = msg.params?._meta ?? {};
      if (access) return connectorCall(env, access, msg.id, name, args, meta);
      const c = new Collector();
      const d = deps(env, true, c, { vh: 'mcp' });
      const client = 'mcp-client';
      if (name === 'request_refund') return reply(toolResult(await refund(env, d, c, { account: 'fan_mcp', client, toCardLast4: String(args.to_card_last4 ?? ''), approvalId: args.approval_id ?? meta[APPROVAL_ID_META] ?? null })));
      if (name === 'enter_presale') return reply(toolResult(await enterPresale(env, d, c, { account: 'fan_mcp', session: { client, sid: mcpSession, user: 'usr_mcp' }, presenceId: args.presence_id ?? meta[PRESENCE_ID_META] ?? null })));
      if (name === 'update_phone') return reply(toolResult(await changePhone(env, d, c, { account: 'fan_mcp', client, phone: String(args.phone_number ?? ''), approvalId: args.approval_id ?? meta[APPROVAL_ID_META] ?? null })));
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    default:
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const TOOL_SCOPE: Record<string, string | null> = { find_shows: null, buy_tickets: 'account:write', get_account: 'account:read' };

async function connectorCall(env: Env, access: Access, id: unknown, name: unknown, args: any, meta: any): Promise<Response> {
  const reply = (result: unknown) => json({ jsonrpc: '2.0', id, result });
  if (typeof name !== 'string' || !(name in TOOL_SCOPE)) return json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
  const need = TOOL_SCOPE[name];
  // account:write (buying, changing the account) includes reading it.
  const has = (x: string) => access.scope.includes(x) || (x === 'account:read' && access.scope.includes('account:write'));
  if (need && !has(need)) return challenge(env, 403, 'insufficient_scope', [...new Set([...access.scope, need])].join(' '), `This needs ${need}. Reconnect Couch Tour and allow it.`);

  if (name === 'find_shows') {
    const q = String(args.query ?? '').trim().toLowerCase();
    const all = showsList().shows;
    const shows = q ? all.filter((s) => `${s.artist} ${s.venue}`.toLowerCase().includes(q)) : all;
    return reply(textResult({ shows, next_show: all[0] }));
  }
  if (name === 'get_account') return reply(textResult(await connectorAccount(env, access.account)));

  // buy_tickets
  const c = new Collector();
  const approvalId = typeof args.approval_id === 'string' ? args.approval_id : typeof meta[APPROVAL_ID_META] === 'string' ? meta[APPROVAL_ID_META] : null;
  const o = await connectorOrder(env, c, { account: access.account, clientId: access.client, quantity: Number(args.quantity ?? 0), approvalId });
  await legacyTrace(env, 'connector', c, o);
  return reply(connectorResult(o));
}

function connectorResult(o: Outcome) {
  if (o.done) return textResult(o.result, `Ordered. ${JSON.stringify(o.result)}`);
  if ('approval' in o) {
    const r = approvalToolResult(o.approval);
    if (o.approval.state === 'requested') {
      const what = o.approval.summary.replace(/[*_`]/g, '').replace(/[.\s]+$/, '');
      r.content[0].text = `Not done yet. Couch Tour asked the account holder to approve "${what}" in the BotShield app on their phone. Tell the user to open the BotShield app and approve, then call buy_tickets again with the same quantity and approval_id ${o.approval.approval_id}.`;
    }
    return r;
  }
  if ('presence' in o) return presenceToolResult(o.presence);
  if (o.error === 'not_verified') return { isError: true, content: [{ type: 'text', text: 'Not done. This Couch Tour account isn\'t BotShield Verified with Couch Tour yet, so Couch Tour can\'t ask the account holder to approve purchases. Verify the account on Couch Tour first, then try again.' }] };
  if (o.error === 'declined') return { isError: true, content: [{ type: 'text', text: 'Not done. Couch Tour can\'t complete this order.' }] };
  if (o.error === 'unavailable' || o.error === 'in_progress') return { isError: true, content: [{ type: 'text', text: 'Not done. Couch Tour is busy for a moment; try again in a few seconds.' }] };
  return { isError: true, content: [{ type: 'text', text: `Not done: ${o.error}` }] };
}

function toolResult(o: Outcome) {
  if (o.done) return { content: [{ type: 'text', text: JSON.stringify(o.result) }], structuredContent: o.result };
  if ('approval' in o) {
    const r = approvalToolResult(o.approval);
    r.content[0].text += o.approval.state === 'requested' ? ` (approval_id: ${o.approval.approval_id})` : '';
    return r;
  }
  if ('presence' in o) {
    const r = presenceToolResult(o.presence);
    r.content[0].text += o.presence.state === 'requested' ? ` (presence_id: ${o.presence.presence_id})` : '';
    return r;
  }
  return { isError: true, content: [{ type: 'text', text: `Not done: ${o.error}` }] };
}
