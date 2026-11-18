/**
 * Couch Tour · Poppy demo. A demo Couch Tour that speaks the Personal Agent Protocol and uses
 * BotShield's extensions, so a viewer can watch the BotShield part of each flow:
 *
 *   POST /api/refunds        botshield.ai/approval   the account holder approves the exact refund
 *   POST /api/presale/enter  botshield.ai/human-presence   one entry per person
 *   POST /mcp                the same two, as MCP tools, for any MCP client (no Poppy needed)
 *   GET  /.well-known/poppy.json
 *   GET  /api/trace          what happened, for the demo page
 *
 * DEMO ONLY. A real Company verifies the Poppy Session header (spec 5.3) and the access token
 * (spec 7). Here one demo account is signed in, and the Session comes from `X-Demo-*` headers or the
 * MCP session. Nothing here touches Couch Tour's production service.
 */
import {
  AccountHolderApproval, BotShieldApi, HumanPresence, NotLinkedError, StillPerformingError, isTransient,
  APPROVAL_ID_HEADER, PRESENCE_ID_HEADER, APPROVAL_ID_META, PRESENCE_ID_META,
  approvalResponse, approvalToolResult, presenceResponse, presenceToolResult,
  type ApprovalObject, type PresenceObject,
} from '../../../packages/poppy/src/index.ts';
import { DemoState, doStore, type TraceEntry } from './state.ts';

export { DemoState };

export interface Env {
  STATE: DurableObjectNamespace<DemoState>;
  BOTSHIELD_API_URL: string;
  BOTSHIELD_SECRET_KEY: string;
  DEMO_ACCOUNT_REF: string;
  DEMO_HOST: string;
  DEMO_AGENT_NAME: string;
  DEMO_REFUND_ACTION: string;
  DEMO_PRESENCE_GATE: string;
  DEMO_ADMIN_TOKEN?: string;
}

/** The demo order: what a refund would return. */
const ORDER = {
  id: 'ord_RW-4417',
  show: 'Rising Wave Live · Red Rocks',
  date: 'Fri, Dec 5',
  tickets: 2,
  each: 48,
  originalCard: '0912',
};

type Session = { client: string; sid: string; user: string };

function deps(env: Env) {
  const stub = env.STATE.get(env.STATE.idFromName('demo'));
  const api = new BotShieldApi({ secretKey: env.BOTSHIELD_SECRET_KEY, baseUrl: env.BOTSHIELD_API_URL });
  return {
    stub,
    approvals: new AccountHolderApproval({ api, agent: env.DEMO_AGENT_NAME, actionKey: env.DEMO_REFUND_ACTION, store: doStore(stub, 'approval') }),
    presence: new HumanPresence({ api, gate: env.DEMO_PRESENCE_GATE, store: doStore(stub, 'presence') }),
    trace: (flow: string, lane: TraceEntry['lane'], title: string, detail?: unknown) =>
      stub.trace({ at: new Date().toISOString(), flow, lane, title, ...(detail === undefined ? {} : { detail }) }),
  };
}

// ── The two actions, shared by the API and the MCP tools ─────────────────────────────────────────

type Outcome<T> = { done: true; result: T } | { done: false; approval: ApprovalObject } | { done: false; presence: PresenceObject } | { done: false; error: string; status: number };

async function refund(env: Env, session: Session, input: { toCardLast4: string; approvalId: string | null }): Promise<Outcome<Record<string, unknown>>> {
  const d = deps(env);
  const last4 = String(input.toCardLast4 ?? '').replace(/\D/g, '').slice(-4);
  if (last4.length !== 4) return { done: false, error: 'to_card_last4 must be four digits', status: 400 };
  const total = ORDER.tickets * ORDER.each;
  await d.trace('refund', 'assistant', `Refund ${ORDER.tickets} tickets to card ending ${last4}`, { order_id: ORDER.id, to_card_last4: last4, approval_id: input.approvalId });
  try {
    const r = await d.approvals.require<Record<string, unknown>>({
      account: env.DEMO_ACCOUNT_REF,
      client: session.client,
      approvalId: input.approvalId,
      meaning: { order: ORDER.id, to: last4 },
      summary: `Refund ${ORDER.tickets} tickets to a **different card**, ending ${last4}.`,
      terms: [
        { label: 'Show', value: `${ORDER.show} · ${ORDER.date}` },
        { label: 'Tickets', value: `${ORDER.tickets} × $${ORDER.each.toFixed(2)}` },
        { label: 'Refund to', value: `Card ending ${last4} (paid with ${ORDER.originalCard})` },
        { label: 'Total', value: `$${total.toFixed(2)}` },
      ],
    });
    if (!r.approved) {
      await d.trace('refund', 'company', r.approval.state === 'requested' ? 'Asked the account holder through BotShield' : `The account holder's answer: ${r.approval.state}`, r.approval);
      return { done: false, approval: r.approval };
    }
    let ranNow = false;
    const result = await r.perform(async () => {
      ranNow = true;
      return { refunded: true, order_id: ORDER.id, amount: `$${total.toFixed(2)}`, to_card_last4: last4, at: new Date().toISOString() };
    });
    if (ranNow) {
      await d.trace('refund', 'botshield', 'Signed answer checked once: the account holder approved these terms', { approval_id: r.approvalId });
      await d.trace('refund', 'company', 'Refunded, once', result);
    } else {
      await d.trace('refund', 'company', 'Already refunded: same result returned, nothing done again', result);
    }
    return { done: true, result };
  } catch (e) {
    if (e instanceof NotLinkedError) return { done: false, error: 'This account is not linked to BotShield.', status: 403 };
    if (e instanceof StillPerformingError) return { done: false, error: 'in_progress', status: 503 };
    if (isTransient(e)) return { done: false, error: 'unavailable', status: 503 };
    throw e;
  }
}

async function enterPresale(env: Env, session: Session, presenceId: string | null): Promise<Outcome<Record<string, unknown>>> {
  const d = deps(env);
  await d.trace('presale', 'assistant', `Enter the presale for ${ORDER.show}`, { presence_id: presenceId });
  try {
    const r = await d.presence.require({ session, presenceId });
    if (!r.passed) {
      await d.trace('presale', 'company', r.presence.state === 'requested' ? 'A person must confirm: link sent' : `Check ended: ${r.presence.state}`, r.presence);
      return { done: false, presence: r.presence };
    }
    const result = { entered: true, show: ORDER.show, at: new Date().toISOString() };
    await d.trace('presale', 'botshield', 'Signed answer checked once: a person was present, counted once');
    await d.trace('presale', 'company', 'Entered', result);
    return { done: true, result };
  } catch (e) {
    if (isTransient(e)) return { done: false, error: 'unavailable', status: 503 };
    throw e;
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function asHttp<T>(o: Outcome<T>): Response {
  if (o.done) return json(o.result);
  if ('approval' in o) { const r = approvalResponse(o.approval); return json(r.body, r.status, r.headers); }
  if ('presence' in o) { const r = presenceResponse(o.presence); return json(r.body, r.status, r.headers); }
  return json({ error: o.error }, o.status, o.status === 503 ? { 'Retry-After': '5' } : {});
}

function sessionFrom(req: Request): Session {
  return {
    client: req.headers.get('X-Demo-Client') ?? 'https://agent.example/agent.json',
    sid: req.headers.get('X-Demo-Sid') ?? 'demo-sid',
    user: req.headers.get('X-Demo-User') ?? 'usr_demo',
  };
}

function poppyJson(env: Env) {
  const origin = `https://${env.DEMO_HOST}`;
  return {
    protocol_version: '1.0',
    organization: { name: 'Couch Tour (demo)', domain: env.DEMO_HOST },
    apis: [
      { type: 'openapi', url: `${origin}/openapi.json`, description: 'Refunds and presale entries (demo)' },
      { type: 'mcp', url: `${origin}/mcp`, description: 'Refunds and presale entries (demo)' },
    ],
    extensions: { 'botshield.ai/approval': [{ version: '1' }], 'botshield.ai/human-presence': [{ version: '1' }] },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/poppy.json') return json(poppyJson(env));
      if (req.method === 'POST' && url.pathname === '/api/refunds') {
        const body = (await req.json().catch(() => ({}))) as { to_card_last4?: string };
        return asHttp(await refund(env, sessionFrom(req), { toCardLast4: String(body.to_card_last4 ?? ''), approvalId: req.headers.get(APPROVAL_ID_HEADER) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/presale/enter') {
        return asHttp(await enterPresale(env, sessionFrom(req), req.headers.get(PRESENCE_ID_HEADER)));
      }
      if (url.pathname === '/mcp') return mcp(req, env);
      if (req.method === 'GET' && url.pathname === '/api/trace') return json(await deps(env).stub.traces());
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        if (!env.DEMO_ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.DEMO_ADMIN_TOKEN}`) return json({ error: 'forbidden' }, 403);
        await deps(env).stub.reset();
        return json({ reset: true });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return new Response('<!doctype html><title>Couch Tour · Poppy demo</title><p>The demo page is coming. Try <code>/.well-known/poppy.json</code> or <code>/mcp</code>.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('[demo]', e instanceof Error ? e.message : String(e));
      return json({ error: 'server_error' }, 500);
    }
  },
};

// ── MCP (Streamable HTTP, JSON responses; protocol 2025-06-18) ───────────────────────────────────

const TOOLS = [
  {
    name: 'request_refund',
    description:
      `Refund the customer's ${ORDER.tickets} tickets for ${ORDER.show} (${ORDER.date}) to a card. ` +
      'A refund to a different card than the one paid with needs the account holder\'s approval in the BotShield app on their phone; ' +
      'if the result says so, tell the user to approve there, then call this tool again with the approval_id.',
    inputSchema: {
      type: 'object',
      properties: {
        to_card_last4: { type: 'string', description: 'Last four digits of the card to refund to.' },
        approval_id: { type: 'string', description: 'From an earlier result, when repeating the request.' },
      },
      required: ['to_card_last4'],
    },
  },
  {
    name: 'enter_presale',
    description:
      `Enter the customer in the presale for ${ORDER.show}. One entry per person. ` +
      'If the result has a link, show it to the user to confirm in the BotShield app, then call this tool again with the presence_id.',
    inputSchema: {
      type: 'object',
      properties: { presence_id: { type: 'string', description: 'From an earlier result, when repeating the request.' } },
    },
  },
];

async function mcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const msg = (await req.json().catch(() => null)) as { id?: unknown; method?: string; params?: any } | null;
  if (!msg || typeof msg.method !== 'string') return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  if (msg.id === undefined) return new Response(null, { status: 202 }); // a notification
  const reply = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });
  const mcpSession = req.headers.get('Mcp-Session-Id') ?? 'mcp';

  switch (msg.method) {
    case 'initialize':
      return json(
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'couchtour-poppy-demo', version: '0.1.0' } } },
        200,
        { 'Mcp-Session-Id': crypto.randomUUID() },
      );
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const meta = msg.params?._meta ?? {};
      const session: Session = { client: 'mcp-client', sid: mcpSession, user: 'usr_mcp' };
      if (name === 'request_refund') {
        const o = await refund(env, session, { toCardLast4: String(args.to_card_last4 ?? ''), approvalId: args.approval_id ?? meta[APPROVAL_ID_META] ?? null });
        return reply(toolResult(o));
      }
      if (name === 'enter_presale') {
        const o = await enterPresale(env, session, args.presence_id ?? meta[PRESENCE_ID_META] ?? null);
        return reply(toolResult(o));
      }
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    default:
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

function toolResult<T>(o: Outcome<T>) {
  if (o.done) return { content: [{ type: 'text', text: JSON.stringify(o.result) }], structuredContent: o.result };
  if ('approval' in o) {
    const r = approvalToolResult(o.approval);
    // Say the id the model must send back, in words a model will follow.
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
