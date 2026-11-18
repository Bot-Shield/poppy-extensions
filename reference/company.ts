/**
 * A reference Company for both extensions: a ticket presale (human presence) and a plan change (the
 * account holder's approval). Node.js 22.18+ (runs TypeScript directly), no dependencies.
 *
 *   BOTSHIELD_SECRET_KEY=bs_dev_… node reference/company.ts
 *
 * DEMO ONLY: a real Company verifies the Poppy Session header (spec 5.3) and the access token
 * (spec 7) before trusting who is asking. Here the Session and the signed-in account come from plain
 * `X-Demo-*` headers, so the flow can be tried without a Personal Agent's keys.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  AccountHolderApproval, BotShieldApi, HumanPresence, NotLinkedError, StillPerformingError,
  APPROVAL_ID_HEADER, PRESENCE_ID_HEADER, approvalResponse, presenceResponse, isTransient,
} from '../packages/poppy/src/index.ts';

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`${k} is not set`); })();
const api = new BotShieldApi({ secretKey: env('BOTSHIELD_SECRET_KEY'), baseUrl: env('BOTSHIELD_API_URL', 'https://api.botshield.ai') });

/** Human Gate for the presale: one entry per person (set in the Console). */
const presence = new HumanPresence({ api, gate: env('DEMO_PRESENCE_GATE', 'poppy-demo-presale') });
/** BotShield Action `plan`, shown under the agent name the Company registered. */
const approvals = new AccountHolderApproval({ api, agent: env('DEMO_AGENT_NAME', 'personal-agents'), actionKey: env('DEMO_ACTION_KEY', 'plan') });
/** A gate whose link setting is `required`: one tap links an account so its holder can be asked. */
const LINK_GATE = env('DEMO_LINK_GATE', 'link');

const PLANS: Record<string, { name: string; price: string }> = {
  'unlimited-plus': { name: 'Unlimited Plus', price: '$95.00' },
  basic: { name: 'Basic', price: '$35.00' },
};
const entries = new Set<string>();

const poppyJson = {
  protocol_version: '1.0',
  organization: { name: 'Example Mobile (demo)', domain: 'localhost' },
  apis: [{ type: 'openapi', url: 'https://localhost/openapi.json', description: 'Presale entries and plans (demo)' }],
  extensions: { 'botshield.ai/approval': [{ version: '1' }], 'botshield.ai/human-presence': [{ version: '1' }] },
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const h = (n: string) => (req.headers[n.toLowerCase()] as string | undefined) ?? null;
  const session = { client: h('X-Demo-Client') ?? 'https://agent.example/agent.json', sid: h('X-Demo-Sid') ?? 'demo-sid', user: h('X-Demo-User') ?? 'usr_demo' };
  const account = h('X-Demo-Account');

  if (req.method === 'GET' && url.pathname === '/.well-known/poppy.json') return send(res, 200, poppyJson);

  // Human presence: enter the presale, one entry per person.
  if (req.method === 'POST' && url.pathname === '/presale/enter') {
    const r = await presence.require({ session, presenceId: h(PRESENCE_ID_HEADER) });
    if (!r.passed) return sendOut(res, presenceResponse(r.presence));
    const key = `${session.client}|${session.sid}`;
    const first = !entries.has(key);
    entries.add(key);
    return send(res, 200, { entered: true, first_entry_in_this_session: first });
  }

  // One-time setup for approvals: link this account to BotShield with one passkey tap.
  if (req.method === 'POST' && url.pathname === '/account/link') {
    if (!account) return send(res, 401, { error: 'sign_in_required' });
    const c = await api.startGateCheck({ gate: LINK_GATE, partnerUserRef: account });
    return send(res, 200, { link_id: c.request_id, verification_uri: c.web_url, expires_at: c.expires_at });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/account/link/')) {
    const s = await api.checkStatus(url.pathname.split('/').pop()!);
    return send(res, 200, { status: s.status, reason: s.reason ?? null });
  }

  // The account holder's approval: change the plan.
  if (req.method === 'POST' && url.pathname === '/plan/change') {
    if (!account) return send(res, 401, { error: 'sign_in_required' });
    const body = await json(req);
    const plan = PLANS[String(body.plan)];
    if (!plan) return send(res, 400, { error: 'unknown_plan' });
    try {
      const r = await approvals.require({
        account,
        client: session.client,
        approvalId: h(APPROVAL_ID_HEADER),
        meaning: { plan: body.plan },
        summary: `Change your plan to **${plan.name}**, from your next bill.`,
        terms: [
          { label: 'Plan', value: plan.name },
          { label: 'Starts', value: 'Your next bill' },
          { label: 'Total', value: `${plan.price} a month` },
        ],
      });
      if (!r.approved) return sendOut(res, approvalResponse(r.approval));
      const done = await r.perform(async () => ({ plan: body.plan, changed_at: new Date().toISOString() }));
      return send(res, 200, { changed: true, ...done });
    } catch (e) {
      if (e instanceof NotLinkedError) return send(res, 403, { error: 'not_available', error_description: 'This account is not linked to BotShield. Link it first: POST /account/link.' });
      if (e instanceof StillPerformingError) return sendOut(res, { status: 503, headers: { 'Retry-After': String(e.retryAfter) }, body: { error: 'in_progress' } });
      throw e;
    }
  }

  return send(res, 404, { error: 'not_found' });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body, null, 2));
}
function sendOut(res: ServerResponse, out: { status: number; headers: Record<string, string>; body: unknown }): void {
  res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers }).end(JSON.stringify(out.body, null, 2));
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[company]', e instanceof Error ? e.message : e);
    if (isTransient(e)) return sendOut(res, { status: 503, headers: { 'Retry-After': '30' }, body: { error: 'unavailable' } });
    send(res, 500, { error: 'server_error' });
  });
}).listen(port, () => console.log(`reference company on http://localhost:${port}`));
