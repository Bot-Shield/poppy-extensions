/**
 * A stand-in Personal Agent that follows both extensions' rules: it never approves, shows the person
 * where to answer, checks BotShield links' hosts, and repeats its request until it's done.
 *
 *   node reference/agent.ts presale
 *   node reference/agent.ts link   --account acct_demo_1
 *   node reference/agent.ts plan   --account acct_demo_1 --plan unlimited-plus
 *
 * DEMO_ALLOW_HOST lets a staging run accept a staging app host (e.g. app-staging.botshield.ai).
 */
import { trustedPresenceLinks, APPROVAL_ID_HEADER, PRESENCE_ID_HEADER } from '../packages/poppy/src/index.ts';

const BASE = process.env.COMPANY_URL ?? 'http://localhost:8787';
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const scenario = process.argv[2];
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  'Poppy-Version': '1.0',
  'Poppy-Extensions': '"botshield.ai/approval";v="1", "botshield.ai/human-presence";v="1"',
  'X-Demo-Client': 'https://agent.example/agent.json',
  'X-Demo-Sid': arg('sid') ?? `sid_${Math.random().toString(36).slice(2, 10)}`,
  'X-Demo-User': 'usr_demo',
  ...(arg('account') ? { 'X-Demo-Account': arg('account')! } : {}),
};
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const say = (m: string) => console.log(`\n[agent] ${m}`);

function linksOk(p: { verification_uri?: string; qr_code_uri?: string }): boolean {
  const allow = process.env.DEMO_ALLOW_HOST;
  if (allow && p.verification_uri && new URL(p.verification_uri).host === allow) return true;
  return trustedPresenceLinks(p);
}

async function repeatUntilDone(path: string, body: unknown): Promise<void> {
  const extra: Record<string, string> = {};
  for (;;) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const out = (await res.json()) as any;
    if (res.ok) return say(`Done: ${JSON.stringify(out)}`);
    if (out.error === 'account_holder_approval_required') {
      const a = out.approval;
      if (a.state !== 'requested') return say(`Not done. The account holder's answer: ${a.state}.`);
      if (!extra[APPROVAL_ID_HEADER]) {
        say('Example Mobile has asked the account holder to approve this in the BotShield app:');
        for (const t of a.terms) console.log(`        ${t.label}: ${t.value}`);
        say('Waiting for their answer…');
      }
      extra[APPROVAL_ID_HEADER] = a.approval_id;
      await sleep(Number(res.headers.get('Retry-After') ?? a.retry_after ?? 5));
      continue;
    }
    if (out.error === 'human_presence_required') {
      const p = out.presence;
      if (p.state !== 'requested') return say(`Not done. The check ended: ${p.state}.`);
      if (!extra[PRESENCE_ID_HEADER]) {
        if (!linksOk(p)) return say('Refusing: the link is not a BotShield link.');
        say(`Example Mobile needs a person to confirm in the BotShield app. Open this on your phone:\n        ${p.verification_uri}`);
        say('Waiting…');
      }
      extra[PRESENCE_ID_HEADER] = p.presence_id;
      await sleep(Number(res.headers.get('Retry-After') ?? p.retry_after ?? 5));
      continue;
    }
    if (res.status === 503) { await sleep(Number(res.headers.get('Retry-After') ?? 2)); continue; }
    return say(`Not done: ${res.status} ${JSON.stringify(out)}`);
  }
}

if (scenario === 'presale') await repeatUntilDone('/presale/enter', {});
else if (scenario === 'plan') await repeatUntilDone('/plan/change', { plan: arg('plan') ?? 'unlimited-plus' });
else if (scenario === 'link') {
  const r = (await (await fetch(`${BASE}/account/link`, { method: 'POST', headers })).json()) as any;
  if (!r.verification_uri) { say(`Could not start: ${JSON.stringify(r)}`); process.exit(1); }
  say(`Link this account to BotShield. Open on your phone:\n        ${r.verification_uri}`);
  for (;;) {
    await sleep(3);
    const s = (await (await fetch(`${BASE}/account/link/${r.link_id}`, { headers })).json()) as any;
    if (s.status !== 'pending') { say(`Link ${s.status}${s.reason ? ` (${s.reason})` : ''}.`); break; }
  }
} else console.log('usage: node reference/agent.ts presale | link --account <ref> | plan --account <ref> [--plan unlimited-plus]');
