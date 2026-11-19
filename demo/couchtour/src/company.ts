/**
 * Couch Tour (demo) as a Poppy Company: discovery (spec 3), an OAuth issuer with Direct Sign-In
 * (spec 4.1, 4.2, 4.4, 4.6, 4.7), Session verification (spec 5.3), APIs (spec 7), and a small Company
 * Agent for conversations (spec 8). Its account actions use BotShield's extensions.
 *
 * DEMO SHORTCUTS, on purpose:
 * - One sign-in account, "the demo fan". The consent page has no password: each browser gets its own
 *   demo account (a random cookie), so visitors don't see each other's changes.
 * - Access and refresh tokens are opaque random strings kept in the Durable Object.
 * - No DPoP, no PAR, no Device Sign-In, no browser join (all optional in the spec).
 * - Session JWT `jti` replay is refused for two minutes; the `iat` window is one minute either side.
 * - Simulated mode (the default) answers with a simulated BotShield inside this Worker
 *   (simBotShield.ts). Live mode, with the demo key, calls BotShield's production sandbox.
 */
import {
  AccountHolderApproval, BotShieldApi, HumanPresence, NotLinkedError, StillPerformingError, isTransient,
  APPROVAL_EXTENSION, PRESENCE_EXTENSION, APPROVAL_ID_HEADER, PRESENCE_ID_HEADER, declares,
  approvalResponse, presenceResponse, type ApprovalObject, type PresenceObject,
} from '../../../packages/poppy/src/index.ts';
import { doStore, type DemoState, type DemoStub } from './state.ts';
import { decodeJwt, pkceChallenge, randomId, sha256b64, short, thumbprint, verifySig, type Jwk } from './jose.ts';
import { getJson, type NetEnv } from './net.ts';
import { Collector, maskPhone, scrub, type Row } from './trace.ts';
import { SIM_BASE, SIM_KEY, simBotShieldFetch } from './simBotShield.ts';

export interface CompanyEnv extends NetEnv {
  STATE: DurableObjectNamespace<DemoState>;
  BOTSHIELD_API_URL: string;
  BOTSHIELD_SECRET_KEY: string;
  DEMO_ACCOUNT_REF: string;
  DEMO_AGENT_NAME: string;
  DEMO_REFUND_ACTION: string;
  DEMO_PHONE_ACTION?: string;
  DEMO_PRESENCE_GATE: string;
  DEMO_LIVE_KEY?: string;
}

type Stub = DemoStub;
export const stubOf = (env: CompanyEnv): Stub => env.STATE.get(env.STATE.idFromName('demo')) as unknown as Stub;
const origin = (env: CompanyEnv) => `https://${env.DEMO_HOST}`;
/** The Company's identifier (spec 3.2): its issuer, which here is its own origin. */
export const issuer = origin;

export const SCOPES: Record<string, { description: string; hints: { changes: 'none' | 'reversible' | 'irreversible'; personal_data: boolean } }> = {
  'account:read': {
    description: 'See your Couch Tour account: the phone number on file (last two digits), your tickets, and your presale entries. Needed to check your account. Not needed to look up shows',
    hints: { changes: 'none', personal_data: true },
  },
  'account:write': {
    description: 'Change your account and orders, like the phone number on file or a refund. Each change also needs the account holder\'s yes in the BotShield app',
    hints: { changes: 'irreversible', personal_data: true },
  },
  presale: {
    description: 'Enter presales for you. Each entry needs a person to confirm in the BotShield app, and counts once per person',
    hints: { changes: 'reversible', personal_data: false },
  },
};

/** Mediated Sign-In, version 1 (a Poppy extension): the agent signs in with the phone number the User gives it. */
export const MEDIATED_GRANT = 'https://personalagentprotocol.org/grant/mediated-sign-in';
const MEDIATED_SCOPES = ['account:read', 'account:write', 'presale'];

export const ORDER = { id: 'ord_RW-4417', show: 'Rising Wave Live · Red Rocks', date: 'Fri, Dec 5', tickets: 2, each: 48, originalCard: '0912' };
const DEFAULT_PHONE = '+17205550187';
const SHOWS = [
  { id: 'shw_rw-redrocks', artist: 'Rising Wave', venue: 'Red Rocks Amphitheatre, Morrison, CO', starts_at: '2026-12-05T19:30:00-07:00', doors: '6:00 PM', presale: { opens_at: '2026-11-20T10:00:00-07:00', rule: 'One entry per person' } },
  { id: 'shw_lm-ogden', artist: 'Low Meadow', venue: 'Ogden Theatre, Denver, CO', starts_at: '2026-12-12T20:00:00-07:00', doors: '7:00 PM' },
];

// ── Discovery ─────────────────────────────────────────────────────────────────────────────────────

export function poppyJson(env: CompanyEnv) {
  const o = origin(env);
  return {
    protocol_version: '1.0',
    organization: { name: 'Couch Tour (demo)', domain: env.DEMO_HOST },
    auth: {
      issuer: issuer(env),
      scopes: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.description])),
      scope_hints: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.hints])),
    },
    agent: {
      protocols: [
        { type: 'poppy', endpoint: `${o}/poppy/conversations`, description: 'Questions about shows, presales, tickets and refund policy. Account changes go through the APIs' },
      ],
    },
    apis: [
      { type: 'openapi', url: `${o}/openapi.json`, description: 'Upcoming shows, your account, changing the phone number on file, refunds, and presale entries' },
      { type: 'mcp', url: `${o}/mcp`, description: 'Refunds, presale entries and phone number changes, as MCP tools (needs the demo key)' },
    ],
    extensions: {
      [APPROVAL_EXTENSION]: [{ version: '1' }],
      [PRESENCE_EXTENSION]: [{ version: '1' }],
      'mediated-sign-in': [{ version: '1', fields: [{ name: 'phone', label: 'Phone number', secret: false }], scopes: MEDIATED_SCOPES }],
    },
  };
}

export function protectedResource(env: CompanyEnv) {
  return { resource: origin(env), authorization_servers: [issuer(env)], scopes_supported: Object.keys(SCOPES), bearer_methods_supported: ['header'], resource_name: 'Couch Tour (demo)' };
}

export function authServerMetadata(env: CompanyEnv) {
  const o = origin(env);
  return {
    issuer: issuer(env),
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    revocation_endpoint: `${o}/oauth/revoke`,
    grant_types_supported: ['authorization_code', 'refresh_token', MEDIATED_GRANT],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256', 'PS384'],
    revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
    revocation_endpoint_auth_signing_alg_values_supported: ['ES256', 'PS384'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    prompt_values_supported: ['consent'],
    scopes_supported: Object.keys(SCOPES),
    protected_resources: [o],
  };
}

export function openApi(env: CompanyEnv) {
  const o = origin(env);
  const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { type: 'object' } } } });
  const approval = err('`account_holder_approval_required` (botshield.ai/approval): the account holder has been asked to approve this in the BotShield app. Repeat the request with the `BotShield-Approval-Id` header.');
  return {
    openapi: '3.1.0',
    info: {
      title: 'Couch Tour (demo) API',
      version: '1.0.0',
      description: 'A demo ticketing API that speaks the Personal Agent Protocol. Account changes need the account holder\'s yes in the BotShield app (botshield.ai/approval); presale entries need a person to confirm (botshield.ai/human-presence).',
    },
    servers: [{ url: o }],
    components: {
      securitySchemes: {
        couchtour: {
          type: 'oauth2',
          flows: { authorizationCode: { authorizationUrl: `${o}/oauth/authorize`, tokenUrl: `${o}/oauth/token`, refreshUrl: `${o}/oauth/token`, scopes: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.description])) } },
        },
      },
    },
    paths: {
      '/api/session': { get: { operationId: 'whoami', summary: 'Who the Session belongs to, and whether it is signed in', security: [{}], responses: { '200': err('The Session') } } },
      '/api/shows/next': { get: { operationId: 'getNextShow', summary: 'The next show on the calendar, with its presale', security: [{}], responses: { '200': err('The next show') } } },
      '/api/account': { get: { operationId: 'getAccount', summary: 'The signed-in account: the phone number on file (last two digits), tickets and presale entries', security: [{ couchtour: ['account:read'] }], responses: { '200': err('The account') } } },
      '/api/account/phone': {
        post: {
          operationId: 'updatePhone',
          summary: 'Change the phone number on the account. Needs the account holder\'s yes in the BotShield app',
          security: [{ couchtour: ['account:write'] }],
          parameters: [{ name: APPROVAL_ID_HEADER, in: 'header', required: false, schema: { type: 'string' }, description: 'When repeating the request, the approval_id from the earlier response' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['phone_number'], properties: { phone_number: { type: 'string', description: 'The new number, e.g. "303 555 0141" or "+13035550141"' } } } } } },
          responses: { '200': err('Changed, once'), '403': approval },
        },
      },
      '/api/refunds': {
        post: {
          operationId: 'requestRefund',
          summary: `Refund the ${ORDER.tickets} tickets for ${ORDER.show} (${ORDER.date}) to a card. Needs the account holder's yes in the BotShield app`,
          security: [{ couchtour: ['account:write'] }],
          parameters: [{ name: APPROVAL_ID_HEADER, in: 'header', required: false, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['to_card_last4'], properties: { to_card_last4: { type: 'string', pattern: '^\\d{4}$' } } } } } },
          responses: { '200': err('Refunded, once'), '403': approval },
        },
      },
      '/api/presale/enter': {
        post: {
          operationId: 'enterPresale',
          summary: `Enter the presale for ${ORDER.show}. One entry per person: a person confirms in the BotShield app`,
          security: [{ couchtour: ['presale'] }],
          parameters: [{ name: PRESENCE_ID_HEADER, in: 'header', required: false, schema: { type: 'string' } }],
          responses: { '200': err('Entered'), '403': err('`human_presence_required` (botshield.ai/human-presence): a person needs to confirm in the BotShield app. Show the link, then repeat the request with the `BotShield-Presence-Id` header.') },
        },
      },
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const oauthErr = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export async function visitorHash(vid: string): Promise<string> {
  return (await sha256b64(`couchtour-demo-visitor:${vid}`)).slice(0, 12).replace(/[-_]/g, 'x');
}
export const accountFor = (vh: string) => `fan_${vh}`;
const vhOf = (account: string) => account.replace(/^fan_/, '');

export function liveAllowed(req: Request, env: CompanyEnv): boolean {
  const key = req.headers.get('X-Demo-Key') ?? new URL(req.url).searchParams.get('key');
  return !!env.DEMO_LIVE_KEY && key === env.DEMO_LIVE_KEY;
}

// ── Client metadata (CIMD, spec 4.1) ──────────────────────────────────────────────────────────────

type ClientMeta = { client_id: string; client_name?: string; jwks_uri: string; redirect_uris: string[]; token_endpoint_auth_method?: string };
const clientCache = new Map<string, { at: number; meta: ClientMeta; jwks: { keys: Jwk[] } }>();

async function client(env: CompanyEnv, clientId: string): Promise<{ meta: ClientMeta; jwks: { keys: Jwk[] } }> {
  const hit = clientCache.get(clientId);
  if (hit && Date.now() - hit.at < 300_000) return hit;
  const u = new URL(clientId);
  if (u.protocol !== 'https:') throw new Error('client_id must be an HTTPS URL');
  const meta = await getJson<ClientMeta>(env, clientId);
  if (meta.client_id !== clientId) throw new Error('client_id in the metadata is not the URL it came from');
  const j = new URL(meta.jwks_uri);
  if (j.protocol !== 'https:' || j.host !== u.host) throw new Error('jwks_uri must be on the client_id\'s domain');
  for (const r of meta.redirect_uris ?? []) {
    const ru = new URL(r);
    if (!(ru.protocol === 'https:' && ru.host === u.host) && !(ru.protocol === 'http:' && /^(127\.0\.0\.1|\[::1\])$/.test(ru.hostname))) throw new Error('redirect_uris must be on the client_id\'s domain');
  }
  const jwks = await getJson<{ keys: Jwk[] }>(env, meta.jwks_uri);
  const entry = { at: Date.now(), meta, jwks };
  clientCache.set(clientId, entry);
  return entry;
}

async function keyFor(jwks: { keys: Jwk[] }, kid: string | undefined): Promise<Jwk | null> {
  for (const k of jwks.keys ?? []) if (k.kid === kid || (!k.kid && kid && (await thumbprint(k)) === kid)) return k;
  return null;
}

/** private_key_jwt client assertion (spec 4.1, RFC 7523). */
async function checkAssertion(env: CompanyEnv, stub: Stub, form: URLSearchParams, c: Collector): Promise<{ ok: true; clientId: string; meta: ClientMeta } | { ok: false; res: Response }> {
  const fail = (d: string) => ({ ok: false as const, res: oauthErr('invalid_client', d, 401) });
  if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return fail('Use private_key_jwt.');
  const a = form.get('client_assertion') ?? '';
  let parts;
  try { parts = decodeJwt(a); } catch { return fail('The client assertion is not a JWT.'); }
  const p = parts.payload;
  if (p.iss !== p.sub || (form.get('client_id') && form.get('client_id') !== p.iss)) return fail('iss and sub must be the client_id.');
  if (p.aud !== issuer(env)) return fail('aud must be the issuer, as one string (spec 4.1).');
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== 'number' || p.exp < now || typeof p.iat !== 'number' || p.exp - p.iat > 300) return fail('exp must be at most 5 minutes after iat, and not passed.');
  if (!p.jti || !(await stub.kvAdd(`ajti:${p.jti}`, 1, 600_000))) return fail('jti missing or reused.');
  let cl;
  try { cl = await client(env, p.iss); } catch (e) { return fail(`Couldn't read the client metadata: ${(e as Error).message}`); }
  const k = await keyFor(cl.jwks, parts.header.kid);
  if (!k || !(await verifySig(parts, k))) return fail('The client assertion\'s signature does not verify.');
  c.note(`✓ Client assertion: ${parts.header.alg}, signed by a key in ${cl.meta.client_name ?? 'the agent'}'s jwks_uri, aud is my issuer (4.1).`);
  return { ok: true, clientId: p.iss, meta: cl.meta };
}

// ── OAuth: authorize (Direct Sign-In, spec 4.2), token, revoke ────────────────────────────────────

type AuthzReq = { client_id: string; client_name: string; redirect_uri: string; scope: string[]; state: string; challenge: string; vid: string };

export async function authorize(req: Request, env: CompanyEnv): Promise<Response> {
  const stub = stubOf(env);
  const url = new URL(req.url);
  if (req.method === 'POST') {
    const f = await req.formData();
    const pending = await stub.kvTake<AuthzReq>(`authz:${f.get('nonce')}`);
    if (!pending) return page('This sign-in has expired. Start again from the chat.');
    const back = new URL(pending.redirect_uri);
    back.searchParams.set('state', pending.state);
    back.searchParams.set('iss', issuer(env));
    const granted = pending.scope.filter((s) => f.getAll('scope').includes(s));
    if (f.get('decision') !== 'allow' || granted.length === 0) {
      back.searchParams.set('error', 'access_denied');
      return Response.redirect(back.toString(), 302);
    }
    const code = randomId('ctac_', 18);
    const account = accountFor(await visitorHash(pending.vid));
    await stub.kvPut(`code:${code}`, { client_id: pending.client_id, redirect_uri: pending.redirect_uri, challenge: pending.challenge, scope: granted, account }, 120_000);
    back.searchParams.set('code', code);
    return Response.redirect(back.toString(), 302);
  }

  const q = url.searchParams;
  const clientId = q.get('client_id') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  let cl;
  try { cl = await client(env, clientId); } catch (e) { return page(`Sign-in can't start: ${(e as Error).message}.`); }
  if (!cl.meta.redirect_uris?.includes(redirectUri)) return page('Sign-in can\'t start: redirect_uri is not one the agent registered.');
  const back = (error: string, description: string) => {
    const b = new URL(redirectUri);
    b.searchParams.set('error', error);
    b.searchParams.set('error_description', description);
    if (q.get('state')) b.searchParams.set('state', q.get('state')!);
    b.searchParams.set('iss', issuer(env));
    return Response.redirect(b.toString(), 302);
  };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'Use response_type=code.');
  if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return back('invalid_request', 'PKCE with S256 is required.');
  const scope = (q.get('scope') ?? '').split(' ').filter(Boolean);
  if (scope.length === 0 || scope.some((s) => !SCOPES[s])) return back('invalid_scope', 'Ask for one or more of: ' + Object.keys(SCOPES).join(', '));

  const vid = cookie(req, 'ct_vid') ?? randomId('v_', 12);
  const nonce = randomId('', 18);
  await stub.kvPut(`authz:${nonce}`, { client_id: clientId, client_name: cl.meta.client_name ?? clientId, redirect_uri: redirectUri, scope, state: q.get('state') ?? '', challenge: q.get('code_challenge')!, vid } satisfies AuthzReq, 600_000);
  return new Response(consentPage(cl.meta.client_name ?? new URL(clientId).host, scope, nonce), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `ct_vid=${vid}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`, 'X-Frame-Options': 'SAMEORIGIN' },
  });
}

export async function token(req: Request, env: CompanyEnv, c: Collector): Promise<Response> {
  const stub = stubOf(env);
  const form = new URLSearchParams(await req.text());
  const a = await checkAssertion(env, stub, form, c);
  if (!a.ok) return a.res;
  const resource = form.get('resource');
  if (resource && resource !== origin(env)) return oauthErr('invalid_target', 'This Company has one resource: ' + origin(env));
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const code = await stub.kvTake<{ client_id: string; redirect_uri: string; challenge: string; scope: string[]; account: string }>(`code:${form.get('code')}`);
    if (!code || code.client_id !== a.clientId) return oauthErr('invalid_grant', 'Unknown or used code.');
    if (code.redirect_uri !== form.get('redirect_uri')) return oauthErr('invalid_grant', 'redirect_uri does not match.');
    if ((await pkceChallenge(form.get('code_verifier') ?? '')) !== code.challenge) return oauthErr('invalid_grant', 'PKCE code_verifier does not match.');
    c.note('✓ Code is one-time, for this client and redirect_uri; PKCE verifier matches the S256 challenge (4.2).');
    const refresh = randomId('ctrt_', 24);
    await stub.kvPut(`rt:${await sha256b64(refresh)}`, { client: a.clientId, account: code.account, scope: code.scope }, 30 * 86400_000);
    const access = await issueAccess(stub, a.clientId, code.account, code.scope, refresh);
    c.note(`Signed in the demo fan with ${code.scope.join(', ')}. Issued an access token (1 hour) and a refresh token (4.7).`);
    return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: code.scope.join(' ') });
  }
  if (grant === 'refresh_token') {
    const rt = form.get('refresh_token') ?? '';
    const rec = await stub.kvGet<{ client: string; account: string; scope: string[] }>(`rt:${await sha256b64(rt)}`);
    if (!rec || rec.client !== a.clientId) return oauthErr('invalid_grant', 'Unknown or revoked refresh token.');
    const want = (form.get('scope') ?? '').split(' ').filter(Boolean);
    if (want.some((s) => !rec.scope.includes(s))) return oauthErr('invalid_scope', 'More scopes than the refresh token has.');
    const scope = want.length ? want : rec.scope;
    const access = await issueAccess(stub, a.clientId, rec.account, scope, rt);
    c.note(`✓ Refresh token is this client's. New access token with ${scope.join(', ')} (4.4).`);
    return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, scope: scope.join(' ') });
  }
  if (grant === MEDIATED_GRANT) {
    // Mediated Sign-In with a phone number. DEMO SHORTCUT: any well-formed number signs in to this
    // browser's demo account, with no one-time code (the extension's step 4 is optional). That a phone
    // number alone opens the account is the weak link the account holder's approval then covers.
    const phone = normalizePhone(form.get('phone') ?? '');
    if (!phone) return oauthErr('invalid_grant', 'That is not a phone number.');
    const scope = (form.get('scope') ?? '').split(' ').filter(Boolean);
    if (!scope.length || scope.some((s) => !MEDIATED_SCOPES.includes(s))) return oauthErr('invalid_scope', 'Ask for one or more of: ' + MEDIATED_SCOPES.join(', '));
    const visitor = req.headers.get('X-Demo-Visitor');
    const account = accountFor(visitor && /^[A-Za-z0-9]{12}$/.test(visitor) ? visitor : (await sha256b64(`phone:${phone}`)).slice(0, 12).replace(/[-_]/g, 'x'));
    if (!(await stub.kvGet(`acct:${account}`))) await stub.kvPut(`acct:${account}`, { phone } satisfies Account, 7 * 86400_000);
    c.note(`Mediated Sign-In (an extension grant, RFC 6749 §4.5): phone number ending ${maskPhone(phone).slice(2)}. A demo: no one-time code.`);
    const refresh = randomId('ctrt_', 24);
    await stub.kvPut(`rt:${await sha256b64(refresh)}`, { client: a.clientId, account, scope }, 30 * 86400_000);
    const access = await issueAccess(stub, a.clientId, account, scope, refresh);
    c.note(`Signed in with ${scope.join(', ')}. Account changes still need the account holder's yes in the BotShield app.`);
    return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: scope.join(' ') });
  }
  return oauthErr('unsupported_grant_type', 'Use authorization_code, refresh_token or the Mediated Sign-In grant.');
}

async function issueAccess(stub: Stub, client: string, account: string, scope: string[], refresh: string): Promise<string> {
  const access = randomId('ctat_', 24);
  await stub.kvPut(`at:${await sha256b64(access)}`, { client, account, scope, rt: await sha256b64(refresh) }, 3600_000);
  return access;
}

export async function revoke(req: Request, env: CompanyEnv, c: Collector): Promise<Response> {
  const stub = stubOf(env);
  const form = new URLSearchParams(await req.text());
  const a = await checkAssertion(env, stub, form, c);
  if (!a.ok) return a.res;
  const h = await sha256b64(form.get('token') ?? '');
  const rec = await stub.kvGet<{ client: string }>(`rt:${h}`);
  if (rec && rec.client === a.clientId) {
    await stub.kvDel(`rt:${h}`);
    await stub.kvAdd(`revoked:${h}`, 1, 86400_000);
    c.note('Revoked the refresh token. Its access tokens stop working too (RFC 7009).');
  }
  return new Response(null, { status: 200 });
}

// ── Sessions (spec 5.2, 5.3) and access tokens (spec 4.5, 7) ──────────────────────────────────────

export type Session = { client: string; clientName: string; sid: string; user: string };
type Access = { client: string; account: string; scope: string[]; rt: string };

export async function verifySession(req: Request, env: CompanyEnv, c: Collector): Promise<{ ok: true; s: Session; access: Access | null; token: string | null } | { ok: false; res: Response }> {
  const stub = stubOf(env);
  const bad = (d: string) => {
    c.note(`✗ ${d}`);
    return { ok: false as const, res: json({ error: 'invalid_session', error_description: d }, 400) };
  };
  const v = req.headers.get('Poppy-Version');
  if (!v || !/^1\.\d+$/.test(v)) {
    c.note('✗ Poppy-Version is missing or not 1.x.');
    return { ok: false, res: json({ error: 'version_unsupported' }, 400) };
  }
  const jwt = req.headers.get('Poppy-Session');
  if (!jwt) return bad('No Poppy-Session header.');
  let s, d;
  try {
    s = decodeJwt(jwt);
    d = decodeJwt(String(s.header.poppy_dlg ?? ''));
  } catch { return bad('The Session JWT, or its delegation in poppy_dlg, is not a JWT.'); }
  if (s.header.typ !== 'poppy-session+jwt' || s.header.alg !== 'ES256') return bad('typ must be poppy-session+jwt and alg ES256.');
  const p = s.payload;
  let cl;
  try { cl = await client(env, String(p.iss)); } catch (e) { return bad(`Couldn't read the agent's client metadata: ${(e as Error).message}`); }
  // Delegated keys, in the spec's order.
  const root = await keyFor(cl.jwks, d.header.kid);
  if (!root || !(await verifySig(d, root))) return bad('The delegation is not signed by a key in the agent\'s jwks_uri.');
  const now = Math.floor(Date.now() / 1000);
  if (d.header.typ !== 'poppy-delegation+jwt' || d.payload.iss !== p.iss || !(d.payload.exp > now) || d.payload.exp - d.payload.iat > 86400) return bad('The delegation is expired, too long, or for another client.');
  const cnf = d.payload.cnf?.jwk as Jwk | undefined;
  if (!cnf || cnf.d || cnf.kty !== 'EC' || cnf.crv !== 'P-256') return bad('The delegation\'s cnf.jwk must be a public P-256 key.');
  if ((await thumbprint(cnf)) !== s.header.kid || !(await verifySig(s, cnf))) return bad('The Session JWT is not signed by the delegated key.');
  // Claims.
  if (p.aud !== issuer(env)) return bad(`aud must be my identifier, ${issuer(env)}.`);
  const u = new URL(req.url);
  if (p.htm !== req.method || p.htu !== `${u.origin}${u.pathname}`) return bad('htm and htu must match this request.');
  if (typeof p.iat !== 'number' || Math.abs(now - p.iat) > 60) return bad('iat is outside my one-minute window.');
  if (!p.sid || !p.sub || !p.jti || !/^[A-Za-z0-9_-]{1,256}$/.test(String(p.sid))) return bad('sid, sub and jti are required.');
  if (!(await stub.kvAdd(`sjti:${p.jti}`, 1, 120_000))) return bad('This Session JWT was already used.');
  const auth = req.headers.get('Authorization');
  const tok = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (tok ? p.ath !== (await sha256b64(tok)) : p.ath !== undefined) return bad('ath must be the hash of the access token, and absent without one.');
  c.note(`✓ Legit: ${cl.meta.client_name ?? 'the agent'} signed this request's Session JWT with a delegated key that a key in its jwks_uri vouches for (5.2, 5.3).`);

  const session: Session = { client: String(p.iss), clientName: cl.meta.client_name ?? String(p.iss), sid: String(p.sid), user: String(p.sub) };
  const sk = `sess:${session.client}|${session.sid}|${session.user}`;
  const known = await stub.kvGet(sk);
  if (!known) await stub.kvPut(sk, { at: Date.now() }, 86400_000);
  let access: Access | null = null;
  if (tok) {
    access = await stub.kvGet<Access>(`at:${await sha256b64(tok)}`);
    if (access && (await stub.kvGet(`revoked:${access.rt}`))) access = null;
    if (access && access.client !== session.client) access = null;
  }
  c.note(`${known ? 'Continued' : 'Started'} Session ${short(session.sid, 8, 0)} for this agent and user. ${tok ? (access ? `Signed in, with ${access.scope.join(', ')}.` : 'The access token is not valid.') : 'No access token, so it\'s signed out.'}`);
  return { ok: true, s: session, access, token: tok };
}

/** The account a request may act on, or the OAuth challenge (spec 7). */
function needScope(env: CompanyEnv, v: { access: Access | null; token: string | null }, scope: string, c: Collector): { ok: true; access: Access } | { ok: false; res: Response } {
  const realm = `realm="${env.DEMO_HOST}"`;
  if (!v.token) {
    c.note(`This needs the account, and the request is signed out. Challenge with scope "${scope}" (7).`);
    return { ok: false, res: json({ error_description: `Sign in to Couch Tour with ${scope} to do this.` }, 401, { 'WWW-Authenticate': `Bearer ${realm}, scope="${scope}"` }) };
  }
  if (!v.access) {
    c.note('The access token is expired, revoked or not this agent\'s: invalid_token.');
    return { ok: false, res: json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': `Bearer ${realm}, error="invalid_token"` }) };
  }
  if (!v.access.scope.includes(scope)) {
    c.note(`The token lacks "${scope}": insufficient_scope.`);
    return { ok: false, res: json({ error: 'insufficient_scope', scope }, 403, { 'WWW-Authenticate': `Bearer ${realm}, error="insufficient_scope", scope="${scope}"` }) };
  }
  return { ok: true, access: v.access };
}

// ── BotShield, live or simulated ──────────────────────────────────────────────────────────────────

export type Deps = {
  mode: 'live' | 'simulated';
  refunds: AccountHolderApproval;
  phones: AccountHolderApproval;
  presence: HumanPresence;
  /** BotShield's reference for a Couch Tour account: the linked demo account when live. */
  ref: (account: string) => string;
};

const BS_TITLES: Record<string, [string, (b: any) => string, string]> = {
  'gates-api/actions/request': ['Ask the account holder to approve', () => 'Sent to their BotShield app', '§ 9'],
  'gates-api/actions/request-status': ['Has the account holder answered?', (b) => (b?.status === 'queued' ? 'Not yet' : `${b?.status}${b?.token ? ', with a signed answer' : ''}`), '§ 9'],
  'sdk/verify-token': ['Check the signed answer, once', (b) => (b?.valid ? 'Valid. Now spent' : 'Not valid'), '§ 8'],
  'sdk/create-session': ['Open a presence check', () => 'Grant for one check', '§ 8'],
  'sdk/create-verification-link': ['… at the presale gate', (b) => (b?.web_url ? 'Link for the person' : 'Refused'), '§ 8'],
  'verification/status': ['Has a person confirmed?', (b) => ({ pending: 'Not yet', completed: 'Confirmed, with a signed answer', failed: `Refused${b?.reason ? ` (${String(b.reason).replace(/_/g, ' ')})` : ''}`, expired: 'Expired' } as Record<string, string>)[b?.status] ?? String(b?.status), '§ 8'],
};

/** Wraps BotShield's fetch so each call Couch Tour makes is recorded for the inspector (scrubbed). */
function recording(base: typeof fetch, c: Collector, simulated: boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const op = url.pathname.replace('/operations/', '');
    const res = await base(input, init);
    const text = await res.clone().text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    let inner: any = body;
    for (let i = 0; i < 2 && inner && typeof inner === 'object' && 'data' in inner; i++) inner = inner.data;
    const [title, result, sec] = BS_TITLES[op] ?? [op, () => `HTTP ${res.status}`, ''];
    const ext = c.ext;
    const q = Object.fromEntries(url.searchParams);
    c.calls.push({
      kind: 'row', lane: 'botshield', title, result: result(inner), simulated,
      tags: [{ s: `${ext === 'approval' ? 'approval' : 'presence'} ${sec}`, ext }],
      req: { method: init?.method ?? 'GET', url: `${url.origin}${url.pathname}${url.search ? '?' + new URLSearchParams(scrub(q) as Record<string, string>) : ''}`, headers: { Authorization: 'Bearer bs_… (Couch Tour\'s secret key, server side)' }, body: init?.body ? scrub(JSON.parse(String(init.body))) : undefined },
      res: { status: res.status, body: scrub(body) },
      fold: op.endsWith('status') ? `bs:${op}:${JSON.stringify(inner?.status)}` : undefined,
    });
    return res;
  }) as typeof fetch;
}

export function deps(env: CompanyEnv, live: boolean, c: Collector, ctx: { vh: string; chat?: string }): Deps {
  const stub = stubOf(env);
  if (live) {
    const api = new BotShieldApi({ secretKey: env.BOTSHIELD_SECRET_KEY, baseUrl: env.BOTSHIELD_API_URL, fetch: recording((i, n) => fetch(i, n), c, false) });
    return {
      mode: 'live',
      refunds: new AccountHolderApproval({ api, agent: env.DEMO_AGENT_NAME, actionKey: env.DEMO_REFUND_ACTION, store: doStore(stub, 'approval') }),
      // The phone change reuses the refund action key unless DEMO_PHONE_ACTION names its own (see README).
      phones: new AccountHolderApproval({ api, agent: env.DEMO_AGENT_NAME, actionKey: env.DEMO_PHONE_ACTION || env.DEMO_REFUND_ACTION, store: doStore(stub, 'approval-phone') }),
      presence: new HumanPresence({ api, gate: env.DEMO_PRESENCE_GATE, store: doStore(stub, 'presence') }),
      ref: () => env.DEMO_ACCOUNT_REF,
    };
  }
  const api = new BotShieldApi({ secretKey: SIM_KEY, baseUrl: SIM_BASE, fetch: recording(simBotShieldFetch(stub, ctx), c, true) });
  return {
    mode: 'simulated',
    refunds: new AccountHolderApproval({ api, agent: env.DEMO_AGENT_NAME, actionKey: 'refund', store: doStore(stub, 'sim-approval'), retryAfter: 3, checkEvery: 2 }),
    phones: new AccountHolderApproval({ api, agent: env.DEMO_AGENT_NAME, actionKey: 'phone', store: doStore(stub, 'sim-approval-phone'), retryAfter: 3, checkEvery: 2 }),
    presence: new HumanPresence({ api, gate: env.DEMO_PRESENCE_GATE, store: doStore(stub, 'sim-presence'), retryAfter: 3, checkEvery: 2 }),
    ref: (account) => account,
  };
}

// ── The actions ───────────────────────────────────────────────────────────────────────────────────

export type Outcome = { done: true; result: Record<string, unknown> } | { done: false; approval: ApprovalObject } | { done: false; presence: PresenceObject } | { done: false; error: string; status: number };

type Account = { phone: string; presale?: { entered_at: string } };
async function getAccount(stub: Stub, account: string): Promise<Account> {
  return (await stub.kvGet<Account>(`acct:${account}`)) ?? { phone: DEFAULT_PHONE };
}

export function normalizePhone(input: string): string | null {
  const d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 8 && d.length <= 15 && String(input).trim().startsWith('+')) return `+${d}`;
  return null;
}

function approvalErrors(e: unknown, c: Collector): Outcome {
  if (e instanceof NotLinkedError) { c.note('This account is not linked to BotShield, so the account holder can\'t be asked.'); return { done: false, error: 'This account is not linked to BotShield.', status: 403 }; }
  if (e instanceof StillPerformingError) return { done: false, error: 'in_progress', status: 503 };
  if (isTransient(e)) { c.note('BotShield is busy. Nothing was decided; answering 503 with Retry-After.'); return { done: false, error: 'unavailable', status: 503 }; }
  throw e;
}

function noteApproval(a: ApprovalObject, c: Collector, fresh: boolean) {
  if (a.state === 'requested') c.note(fresh ? 'Did nothing. Sent the request for approval to the account holder through BotShield, and answered 403 account_holder_approval_required (approval §5).' : 'The account holder hasn\'t answered yet. Same approval object, state requested (approval §7).');
  else c.note(`The account holder's answer: ${a.state}. Did nothing (approval §7).`);
}

export async function changePhone(env: CompanyEnv, d: Deps, c: Collector, input: { account: string; client: string; phone: string; approvalId: string | null }): Promise<Outcome> {
  const stub = stubOf(env);
  const phone = normalizePhone(input.phone);
  if (!phone) return { done: false, error: 'phone_number must be a full phone number, like 303 555 0141.', status: 400 };
  const acct = await getAccount(stub, input.account);
  if (acct.phone === phone) return { done: true, result: { updated: false, phone_on_file: maskPhone(phone), note: 'That number is already on file.' } };
  c.ext = 'approval';
  c.note(`Changing the phone number on file (${maskPhone(acct.phone)} → ${maskPhone(phone)}) can take over the account. Only the account holder may approve it.`);
  try {
    const r = await d.phones.require<Record<string, unknown>>({
      account: d.ref(input.account),
      client: input.client,
      approvalId: input.approvalId,
      meaning: { op: 'update_phone', account: input.account, phone },
      summary: `Change the phone number on your Couch Tour account to ${maskPhone(phone)}.`,
      terms: [
        { label: 'Account', value: 'Couch Tour · demo fan' },
        { label: 'Number now', value: `Ending ${maskPhone(acct.phone).replace('••', '')}` },
        { label: 'New number', value: `Ending ${maskPhone(phone).replace('••', '')}` },
      ],
    });
    if (!r.approved) { noteApproval(r.approval, c, !input.approvalId); return { done: false, approval: r.approval }; }
    let ranNow = false;
    const result = await r.perform(async () => {
      ranNow = true;
      const cur = await getAccount(stub, input.account);
      await stub.kvPut(`acct:${input.account}`, { ...cur, phone }, 7 * 86400_000);
      return { updated: true, phone_on_file: maskPhone(phone), at: new Date().toISOString() };
    });
    c.note(ranNow ? '✓ The signed answer checked out once: the account holder approved these exact terms. Changed the number, once (approval §7, §9).' : 'Already changed: same result as before, nothing done again (approval §7).');
    return { done: true, result };
  } catch (e) { return approvalErrors(e, c); }
}

export async function refund(env: CompanyEnv, d: Deps, c: Collector, input: { account: string; client: string; toCardLast4: string; approvalId: string | null }): Promise<Outcome> {
  const last4 = String(input.toCardLast4 ?? '').replace(/\D/g, '').slice(-4);
  if (last4.length !== 4) return { done: false, error: 'to_card_last4 must be four digits', status: 400 };
  const total = ORDER.tickets * ORDER.each;
  c.ext = 'approval';
  c.note(`A refund to a different card than the one paid with (${ORDER.originalCard}) is the classic takeover move. Only the account holder may approve it.`);
  try {
    const r = await d.refunds.require<Record<string, unknown>>({
      account: d.ref(input.account),
      client: input.client,
      approvalId: input.approvalId,
      meaning: { order: ORDER.id, to: last4, account: input.account },
      summary: `Refund ${ORDER.tickets} tickets to a **different card**, ending ${last4}.`,
      terms: [
        { label: 'Show', value: `${ORDER.show} · ${ORDER.date}` },
        { label: 'Tickets', value: `${ORDER.tickets} × $${ORDER.each.toFixed(2)}` },
        { label: 'Refund to', value: `Card ending ${last4} (paid with ${ORDER.originalCard})` },
        { label: 'Total', value: `$${total.toFixed(2)}` },
      ],
    });
    if (!r.approved) { noteApproval(r.approval, c, !input.approvalId); return { done: false, approval: r.approval }; }
    let ranNow = false;
    const result = await r.perform(async () => {
      ranNow = true;
      return { refunded: true, order_id: ORDER.id, amount: `$${total.toFixed(2)}`, to_card_last4: last4, at: new Date().toISOString() };
    });
    c.note(ranNow ? '✓ The signed answer checked out once. Refunded, once.' : 'Already refunded: same result, nothing done again.');
    return { done: true, result };
  } catch (e) { return approvalErrors(e, c); }
}

export async function enterPresale(env: CompanyEnv, d: Deps, c: Collector, input: { account: string; session: { client: string; sid: string; user: string }; presenceId: string | null }): Promise<Outcome> {
  const stub = stubOf(env);
  c.ext = 'presence';
  c.note('One entry per person. An agent can open any number of Sessions, so a Session proves nothing. Asking for a person.');
  try {
    const r = await d.presence.require({ session: input.session, presenceId: input.presenceId });
    if (!r.passed) {
      const p = r.presence;
      c.note(p.state === 'requested' ? (input.presenceId ? 'Nobody has confirmed yet. Same presence object (presence §6).' : 'Did nothing. Opened a presence check at BotShield and answered 403 human_presence_required with its link (presence §4).') : p.state === 'refused' ? 'BotShield: this person was already counted at this gate. Refused. I never learn who it was (presence §6).' : `The check ended: ${p.state}.`);
      return { done: false, presence: p };
    }
    const acct = await getAccount(stub, input.account);
    if (acct.presale) {
      c.note('A person confirmed for this Session, and this account is already entered. Same answer, no second entry.');
      return { done: true, result: { entered: true, already_entered: true, show: ORDER.show, at: acct.presale.entered_at } };
    }
    const at = new Date().toISOString();
    await stub.kvPut(`acct:${input.account}`, { ...acct, presale: { entered_at: at } }, 7 * 86400_000);
    c.note('✓ The signed answer checked out once: a person confirmed, counted once at this gate. Entered.');
    return { done: true, result: { entered: true, show: ORDER.show, at } };
  } catch (e) {
    if (isTransient(e)) return { done: false, error: 'unavailable', status: 503 };
    throw e;
  }
}

export function asHttp(o: Outcome): Response {
  if (o.done) return json(o.result);
  if ('approval' in o) { const r = approvalResponse(o.approval); return json(r.body, r.status, r.headers); }
  if ('presence' in o) { const r = presenceResponse(o.presence); return json(r.body, r.status, r.headers); }
  return json({ error: o.error }, o.status, o.status === 503 ? { 'Retry-After': '3' } : {});
}

// ── The API routes (spec 7) ───────────────────────────────────────────────────────────────────────

/** Saves what Couch Tour did for the inspector, keyed by the demo's trace header. */
async function saveTrace(env: CompanyEnv, req: Request, c: Collector) {
  const t = req.headers.get('X-Demo-Trace');
  if (t && /^[A-Za-z0-9_.-]{1,80}$/.test(t)) await stubOf(env).kvPut(`rtrace:${t}`, { notes: c.notes, calls: c.calls as Row[] }, 600_000);
}

export async function companyApi(req: Request, env: CompanyEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const c = new Collector();
  let res: Response | null = null;
  try {
    if (req.method === 'POST' && path === '/oauth/token') res = await token(req, env, c);
    else if (req.method === 'POST' && path === '/oauth/revoke') res = await revoke(req, env, c);
    else if (path.startsWith('/poppy/conversations')) res = await conversations(req, env, c);
    else if (path === '/api/session' || path === '/api/shows/next' || path === '/api/account' || path === '/api/account/phone' || ((path === '/api/refunds' || path === '/api/presale/enter') && req.headers.has('Poppy-Session'))) res = await api(req, env, c, path);
  } finally {
    if (res) await saveTrace(env, req, c);
  }
  return res;
}

async function api(req: Request, env: CompanyEnv, c: Collector, path: string): Promise<Response> {
  if (path === '/api/shows/next' && req.method === 'GET') {
    // Public, uses no Session claims (spec 1, 5.3): no need to verify the Session header here.
    c.note('Public show listings: no account, and no Session claims used, so I don\'t need to verify the Session (5.3).');
    return json({ show: SHOWS[0], then: SHOWS.slice(1) });
  }
  const v = await verifySession(req, env, c);
  if (!v.ok) return v.res;
  const live = liveAllowed(req, env);
  if (path === '/api/session' && req.method === 'GET') {
    return json({ client_id: v.s.client, client_name: v.s.clientName, user_id: v.s.user, session_id: v.s.sid, signed_in: !!v.access, scope: v.access?.scope.join(' ') ?? null, botshield: live ? 'live' : 'simulated' });
  }
  if (path === '/api/account' && req.method === 'GET') {
    const n = needScope(env, v, 'account:read', c);
    if (!n.ok) return n.res;
    const a = await getAccount(stubOf(env), n.access.account);
    return json({ account: 'Demo fan', phone_on_file: maskPhone(a.phone), tickets: [{ order_id: ORDER.id, show: ORDER.show, date: ORDER.date, quantity: ORDER.tickets }], presale_entries: a.presale ? [{ show: ORDER.show, at: a.presale.entered_at }] : [] });
  }
  const ext = req.headers.get('Poppy-Extensions');
  const vh = (a: Access) => vhOf(a.account);
  if (path === '/api/account/phone' && req.method === 'POST') {
    const n = needScope(env, v, 'account:write', c);
    if (!n.ok) return n.res;
    if (!declares(ext, APPROVAL_EXTENSION)) { c.note('This change needs botshield.ai/approval, and the request doesn\'t declare it (3.3).'); return json({ error: 'extension_required', extension: APPROVAL_EXTENSION }, 403); }
    const body = (await req.json().catch(() => ({}))) as { phone_number?: string };
    const d = deps(env, live, c, { vh: vh(n.access), chat: chatOf(req) });
    return asHttp(await changePhone(env, d, c, { account: n.access.account, client: v.s.client, phone: String(body.phone_number ?? ''), approvalId: req.headers.get(APPROVAL_ID_HEADER) }));
  }
  if (path === '/api/refunds' && req.method === 'POST') {
    const n = needScope(env, v, 'account:write', c);
    if (!n.ok) return n.res;
    if (!declares(ext, APPROVAL_EXTENSION)) return json({ error: 'extension_required', extension: APPROVAL_EXTENSION }, 403);
    const body = (await req.json().catch(() => ({}))) as { to_card_last4?: string };
    const d = deps(env, live, c, { vh: vh(n.access), chat: chatOf(req) });
    return asHttp(await refund(env, d, c, { account: n.access.account, client: v.s.client, toCardLast4: String(body.to_card_last4 ?? ''), approvalId: req.headers.get(APPROVAL_ID_HEADER) }));
  }
  if (path === '/api/presale/enter' && req.method === 'POST') {
    const n = needScope(env, v, 'presale', c);
    if (!n.ok) return n.res;
    if (!declares(ext, PRESENCE_EXTENSION)) return json({ error: 'extension_required', extension: PRESENCE_EXTENSION }, 403);
    const d = deps(env, live, c, { vh: vh(n.access), chat: chatOf(req) });
    return asHttp(await enterPresale(env, d, c, { account: n.access.account, session: { client: v.s.client, sid: v.s.sid, user: v.s.user }, presenceId: req.headers.get(PRESENCE_ID_HEADER) }));
  }
  return json({ error: 'not_found' }, 404);
}

const chatOf = (req: Request) => (req.headers.get('X-Demo-Trace') ?? '').split('.')[0] || undefined;

// ── The Company Agent: conversations (spec 8), rule-based ─────────────────────────────────────────

type Conv = { id: string; client: string; user: string; account: string | null; events: any[]; reqs: Record<string, string>; closed: boolean };

async function conversations(req: Request, env: CompanyEnv, c: Collector): Promise<Response> {
  const stub = stubOf(env);
  const v = await verifySession(req, env, c);
  if (!v.ok) return v.res;
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // poppy, conversations, {id}, {action}
  const id = parts[2];
  const action = parts[3];
  const state = (cv: Conv, cursor: string | null) => {
    const i = cursor ? cv.events.findIndex((e) => e.id === cursor) : -1;
    const events = cv.events.slice(i + 1);
    return { conversation_id: cv.id, events, cursor: events.length ? events[events.length - 1].id : cursor, has_more: false, working: false, handoff: 'none', responder: 'agent', closed: cv.closed };
  };
  const load = async () => {
    const cv = id ? await stub.kvGet<Conv>(`conv:${id}`) : null;
    // A conversation belongs to the client and User ID that started it, and its account once used (8.2).
    if (!cv || cv.client !== v.s.client || cv.user !== v.s.user || (cv.account && v.access && v.access.account !== cv.account)) return null;
    return cv;
  };
  if (req.method === 'GET' && action === 'events') {
    const cv = await load();
    if (!cv) return json({ error: 'conversation_not_found' }, 404);
    return json(state(cv, url.searchParams.get('cursor')));
  }
  if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
  const body = (await req.json().catch(() => null)) as { id?: string; message?: { text?: string; author?: { type?: string } } } | null;
  if (!body?.id || !/^[A-Za-z0-9_-]{1,256}$/.test(body.id)) return json({ error: 'invalid_request', error_description: 'Every POST has a request id (8.3).' }, 400);
  let cv: Conv | null;
  if (!id) {
    const prior = await stub.kvGet<string>(`convreq:${v.s.client}|${v.s.user}|${body.id}`);
    cv = prior ? await stub.kvGet<Conv>(`conv:${prior}`) : null;
    if (!cv) {
      cv = { id: randomId('cnv_', 12), client: v.s.client, user: v.s.user, account: v.access?.account ?? null, events: [], reqs: {}, closed: false };
      c.note(`Started conversation ${cv.id}. It belongs to this agent and User ID (8.2).`);
    }
  } else {
    cv = await load();
    if (!cv) return json({ error: 'conversation_not_found' }, 404);
  }
  if (cv.reqs[body.id] === undefined) {
    cv.reqs[body.id] = action ?? 'start';
    const now = new Date().toISOString();
    if (action === 'close') {
      cv.closed = true;
      cv.events.push({ id: randomId('evt_', 6), type: 'state', created_at: now, handoff: 'none', responder: 'agent', closed: true });
    } else if (action === 'handoff') {
      cv.events.push({ id: randomId('evt_', 6), type: 'message', created_at: now, message: { id: randomId('msg_', 8), role: 'company', author: { type: 'agent' }, as_of_request: body.id, text: 'Nobody from Couch Tour is available in this demo. I can help here, or your agent can use our APIs.' } });
    } else if (body.message) {
      cv.events.push({ id: randomId('evt_', 6), type: 'message', created_at: now, message: { ...body.message, id: body.id, role: 'user' } });
      const reply = companyAgentReply(String(body.message.text ?? ''));
      c.note(`Company agent: ${reply.why}`);
      cv.events.push({ id: randomId('evt_', 6), type: 'message', created_at: now, message: { id: randomId('msg_', 8), role: 'company', author: { type: 'agent', name: 'Couch Tour' }, as_of_request: body.id, text: reply.text, ...(reply.data ? { data: reply.data } : {}) } });
    }
    await stub.kvPut(`conv:${cv.id}`, cv, 86400_000);
    if (!id) await stub.kvPut(`convreq:${v.s.client}|${v.s.user}|${body.id}`, cv.id, 86400_000);
  } else {
    c.note(`Request ${short(body.id, 8, 0)} was already accepted: same response, not acted on again (8.3).`);
  }
  const status = id ? 202 : 201;
  if (url.searchParams.has('wait')) return json(state(cv, url.searchParams.get('cursor')), status);
  return json({ conversation_id: cv.id }, status);
}

function companyAgentReply(text: string): { text: string; why: string; data?: Record<string, unknown> } {
  const t = text.toLowerCase();
  if (/(next|upcoming|when).*(show|concert|gig)|show.*(next|when)|calendar/.test(t)) {
    return { why: 'a question about shows. Answered from the calendar.', text: `Your next show is ${SHOWS[0].artist} at Red Rocks on Friday, December 5, 2026, at 7:30 PM Mountain time (doors 6:00 PM). The presale opens November 20 at 10 AM, one entry per person.`, data: { show: SHOWS[0] } };
  }
  if (/refund/.test(t)) return { why: 'refund policy.', text: 'Refunds go back to the card you paid with, within 30 days of the show. A refund to a different card needs the account holder\'s yes in the BotShield app. Your agent can ask through our refunds API.' };
  if (/presale/.test(t)) return { why: 'presale rules.', text: 'Presales are one entry per person. A person confirms in the BotShield app, and each person counts once, whichever agent or account they use.' };
  if (/phone|number|email|account|password/.test(t)) return { why: 'an account change. Chat can\'t change accounts.', text: 'I can\'t change account details in chat. Your agent can use our account API: a change like a new phone number needs the account holder\'s yes in the BotShield app.' };
  return { why: 'a general question.', text: 'I can help with shows, presales, tickets and refund policy. What would you like to know?' };
}

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────────

function cookie(req: Request, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{4,64})`).exec(req.headers.get('Cookie') ?? '');
  return m ? m[1] : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const SHEET_CSS = `
:root{--ink:#17151c;--muted:#6b6875;--line:#e7e4ec;--ct:#b4235a;--ct-soft:#fbeaf1;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#f1eff5;--muted:#a19dab;--line:#34303c;--ct:#f06a9b;--ct-soft:#3a1c29;--bg:#17151c}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);padding:20px 18px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ct)}.dot{width:26px;height:26px;border-radius:7px;background:var(--ct);color:#fff;display:grid;place-items:center;font-size:13px}
h1{font-size:20px;margin:16px 0 4px}p{margin:6px 0;color:var(--muted)}.who{display:inline-block;margin:8px 0 14px;padding:4px 10px;border-radius:99px;background:var(--ct-soft);color:var(--ct);font-weight:600;font-size:13px}
label{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line);font-size:14px}label b{display:block}label span{color:var(--muted);font-size:13px}
input[type=checkbox]{margin-top:4px;accent-color:var(--ct);width:16px;height:16px}
.btns{display:flex;flex-direction:column;gap:8px;margin-top:16px}button{font:inherit;font-weight:600;padding:11px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.go{background:var(--ct);border-color:var(--ct);color:#fff}.fine{font-size:12px;margin-top:14px}`;

function consentPage(clientName: string, scope: string[], nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Couch Tour</title><style>${SHEET_CSS}</style></head><body>
<div class="brand"><span class="dot">CT</span>Couch Tour</div>
<h1>Sign in to Couch Tour</h1>
<div class="who">as the demo fan</div>
<p><b style="color:var(--ink)">${esc(clientName)}</b> is asking to:</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="nonce" value="${esc(nonce)}">
${scope.map((s) => `<label><input type="checkbox" name="scope" value="${esc(s)}" checked><div><b>${esc(s)}</b><span>${esc(SCOPES[s].description)}.</span></div></label>`).join('')}
<div class="btns"><button class="go" name="decision" value="allow" data-testid="consent-allow">Allow</button><button name="decision" value="deny">Don't allow</button></div>
</form>
<p class="fine">A demo: there's no password. A real Couch Tour sign-in asks you to sign in here first. You can sign out at any time, which ends this access.</p>
</body></html>`;
}

function page(message: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Couch Tour</title><style>${SHEET_CSS}</style></head><body><div class="brand"><span class="dot">CT</span>Couch Tour</div><h1>Sign in</h1><p>${esc(message)}</p></body></html>`, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
