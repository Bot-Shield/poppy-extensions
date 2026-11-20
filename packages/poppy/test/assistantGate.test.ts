import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantGate, assistantClientIdUrl, isPublicAddress, readAssistantName } from '../src/assistantGate.ts';
import { approvalToolResult } from '../src/approval.ts';
import { BotShieldApi } from '../src/api.ts';
import { fakeBotShield, type FakeState } from './fakeBotShield.ts';

const assistant = { clientId: 'https://agent.example/agent.json', userId: 'usr_Q7c1vK' };

function setup(onUnapproved?: 'ask' | 'signal') {
  const state: FakeState = { linked: true, calls: [] };
  const api = new BotShieldApi({ secretKey: 'bs_production_test', fetch: fakeBotShield(state) });
  const gate = new AssistantGate({ api, agent: 'personal-agents', checkEvery: 0, readName: async () => 'Example Agent', ...(onUnapproved ? { onUnapproved } : {}) });
  return { state, gate };
}

const asks = (state: FakeState) => state.calls.filter((c) => c === 'gates-api/actions/request').length;

test('first checkout: the account holder is asked, with the assistant named from its metadata', async () => {
  const { state, gate } = setup();
  const r = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!r.allowed && 'approval' in r);
  assert.equal(r.approval.summary, 'Let Example Agent buy for you');
  assert.deepEqual(r.approval.terms.map((t) => t.label), ['Assistant', 'From', 'It can']);
  assert.match(state.action!.act, /^assistant:[A-Za-z0-9_-]{43}$/);
  assert.match(approvalToolResult(r.approval).content[0].text, /BotShield app/);
});

test('approved: registered once, then every checkout is checked fresh', async () => {
  const { state, gate } = setup();
  const first = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!first.allowed && 'approval' in first);
  state.action!.status = 'approved';
  const a = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1', approvalId: first.approval.approval_id });
  assert.ok(a.allowed);
  const b = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_2' });
  assert.ok(b.allowed);
  assert.notEqual(a.allowed && a.checkId, b.allowed && b.checkId, 'a new answer per order');
  assert.equal(state.calls.filter((c) => c === 'gates-api/assistants/register').length, 1);
  assert.equal(state.calls.filter((c) => c === 'gates-api/assistants/check').length, 2);
});

test('removed by the person: the next checkout is refused and asks again', async () => {
  const { state, gate } = setup();
  const first = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!first.allowed && 'approval' in first);
  state.action!.status = 'approved';
  assert.ok((await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1', approvalId: first.approval.approval_id })).allowed);
  for (const v of state.assistants!.values()) v.removed = true;
  const after = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_2' });
  assert.equal(after.allowed, false);
});

test('a different assistant or account never rides on the approval', async () => {
  const { state, gate } = setup();
  const first = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!first.allowed && 'approval' in first);
  state.action!.status = 'approved';
  assert.ok((await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1', approvalId: first.approval.approval_id })).allowed);
  assert.equal((await gate.require({ account: 'acct_1', assistant: { ...assistant, clientId: 'https://other.example/agent.json' }, orderRef: 'ord_2' })).allowed, false);
  assert.equal((await gate.require({ account: 'acct_2', assistant, orderRef: 'ord_3' })).allowed, false);
  assert.equal((await gate.require({ account: 'acct_1', assistant: { ...assistant, userId: 'usr_other' }, orderRef: 'ord_4' })).allowed, false);
});

test('an assistant whose metadata cannot be read is refused, and no one is asked', async () => {
  const state: FakeState = { linked: true, calls: [] };
  const api = new BotShieldApi({ secretKey: 'bs_production_test', fetch: fakeBotShield(state) });
  const gate = new AssistantGate({ api, agent: 'personal-agents', readName: async () => null });
  const r = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.deepEqual(r, { allowed: false, refused: 'assistant_unknown' });
  assert.equal(state.calls.length, 0);
});

test('default is unchanged: a no-match after removal asks the account holder again', async () => {
  const { state, gate } = setup();
  const first = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!first.allowed && 'approval' in first);
  state.action!.status = 'approved';
  assert.ok((await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1', approvalId: first.approval.approval_id })).allowed);
  for (const v of state.assistants!.values()) v.removed = true;
  const after = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_2' });
  assert.ok(!after.allowed && 'approval' in after);
  assert.equal(after.approval.state, 'requested');
  assert.equal(asks(state), 2);
});

test("signal mode: an assistant the gate has never seen asks nobody", async () => {
  const { state, gate } = setup('signal');
  const r = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.deepEqual(r, { allowed: false, match: false });
  assert.equal(asks(state), 0);
  assert.equal(state.calls.length, 0);
});

test('signal mode: a no-match after the check asks nobody', async () => {
  const { state, gate } = setup('signal');
  const first = await gate.ask({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!first.allowed && 'approval' in first);
  state.action!.status = 'approved';
  assert.ok((await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1', approvalId: first.approval.approval_id })).allowed);
  const matched = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_2' });
  assert.ok(matched.allowed);
  for (const v of state.assistants!.values()) v.removed = true;
  const after = await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_3' });
  assert.deepEqual(after, { allowed: false, match: false });
  assert.equal(asks(state), 1, 'only the ask() the Company chose');
});

test('ask(): the Company starts the approval when it chooses', async () => {
  const { state, gate } = setup('signal');
  assert.deepEqual(await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' }), { allowed: false, match: false });
  const r = await gate.ask({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!r.allowed && 'approval' in r);
  assert.equal(r.approval.summary, 'Let Example Agent buy for you');
  assert.equal(asks(state), 1);
  const again = await gate.ask({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.ok(!again.allowed && 'approval' in again);
  assert.equal(again.approval.approval_id, r.approval.approval_id, 'a waiting approval is not asked twice');
  assert.equal(asks(state), 1);
});

// The name check matches BotShield's own, so nobody is asked about an assistant it would refuse.

const meta = (body: unknown, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const publicDns = async () => ['93.184.215.14'];
const goodId = 'https://agent.example/agent.json';

test('client_id: only an HTTPS URL on a public DNS name is read', () => {
  assert.ok(assistantClientIdUrl(goodId));
  for (const bad of [
    'http://agent.example/agent.json',
    'https://user:pw@agent.example/agent.json',
    'https://agent.example/agent.json#x',
    'https://127.0.0.1/agent.json',
    'https://2130706433/agent.json',
    'https://[::1]/agent.json',
    'https://[2606:4700::1]/agent.json',
    'https://93.184.215.14/agent.json',
    'https://localhost/agent.json',
    'https://a.localhost/agent.json',
    'https://printer.local/agent.json',
    'https://svc.internal/agent.json',
    ` ${goodId}`,
    `${goodId} `,
    `https://agent.example/${'a'.repeat(2048)}`,
    'not a url',
    '',
  ]) assert.equal(assistantClientIdUrl(bad), null, bad);
});

test('public addresses: private, loopback, link-local, CGNAT, multicast and reserved are not', () => {
  for (const a of ['93.184.215.14', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(isPublicAddress(a), a);
  for (const a of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nope']) assert.equal(isPublicAddress(a), false, a);
  assert.ok(isPublicAddress('172.32.0.1'));
  assert.ok(isPublicAddress('100.128.0.1'));
});

test('readAssistantName: reads the name when every rule holds', async () => {
  const name = await readAssistantName(goodId, { resolve: publicDns, fetch: meta({ client_id: goodId, client_name: ' Example\u0007 Agent ' }) as typeof fetch });
  assert.equal(name, 'Example Agent');
});

test('readAssistantName: a name that resolves to a private address, or to nothing, is refused before any fetch', async () => {
  let fetched = 0;
  const f = (async () => { fetched++; return new Response(JSON.stringify({ client_id: goodId, client_name: 'X' })); }) as typeof fetch;
  assert.equal(await readAssistantName(goodId, { resolve: async () => ['93.184.215.14', '10.0.0.5'], fetch: f }), null);
  assert.equal(await readAssistantName(goodId, { resolve: async () => [], fetch: f }), null);
  assert.equal(await readAssistantName(goodId, { resolve: async () => { throw new Error('ENOTFOUND'); }, fetch: f }), null);
  assert.equal(fetched, 0);
});

test('readAssistantName: redirects, other statuses, large bodies, a different client_id and bad names are refused', async () => {
  const r = (fetch: unknown) => readAssistantName(goodId, { resolve: publicDns, fetch: fetch as typeof fetch });
  assert.equal(await r(meta({ client_id: goodId, client_name: 'X' }, 302)), null);
  assert.equal(await r(meta({ client_id: goodId, client_name: 'X' }, 404)), null);
  assert.equal(await r(meta(JSON.stringify({ client_id: goodId, client_name: 'X', pad: 'a'.repeat(64 * 1024) }))), null);
  assert.equal(await r(meta({ client_id: 'https://other.example/agent.json', client_name: 'X' })), null);
  assert.equal(await r(meta({ client_id: goodId, client_name: 'x'.repeat(61) })), null);
  assert.equal(await r(meta({ client_id: goodId, client_name: ' \u0001 ' })), null);
  assert.equal(await r(meta({ client_id: goodId })), null);
  assert.equal(await r(meta('not json')), null);
  assert.equal(await r(meta({ client_id: goodId, client_name: 'x'.repeat(60) })), 'x'.repeat(60));
});

test('readAssistantName: the request does not follow redirects', async () => {
  let init: RequestInit | undefined;
  await readAssistantName(goodId, { resolve: publicDns, fetch: (async (_u: string, i: RequestInit) => { init = i; return new Response('{}'); }) as unknown as typeof fetch });
  assert.equal(init?.redirect, 'manual');
});

test('a client_id BotShield would refuse asks nobody, even with a custom name reader', async () => {
  const state: FakeState = { linked: true, calls: [] };
  const api = new BotShieldApi({ secretKey: 'bs_production_test', fetch: fakeBotShield(state) });
  let read = 0;
  const gate = new AssistantGate({ api, agent: 'personal-agents', readName: async () => { read++; return 'Example Agent'; } });
  for (const clientId of ['https://10.0.0.5/agent.json', 'http://agent.example/agent.json', 'https://svc.internal/agent.json']) {
    const r = await gate.require({ account: 'acct_1', assistant: { clientId, userId: 'usr_1' }, orderRef: 'ord_1' });
    assert.deepEqual(r, { allowed: false, refused: 'assistant_unknown' }, clientId);
  }
  assert.equal(read, 0);
  assert.equal(state.calls.length, 0);
});

test('the approval request carries the assistant id, so BotShield sets the title from its own read of the name', async () => {
  const { state, gate } = setup();
  await gate.require({ account: 'acct_1', assistant, orderRef: 'ord_1' });
  assert.equal(state.lastRequest?.assistant_client_id, assistant.clientId);
  assert.equal(state.lastRequest?.assistant_user_id, assistant.userId);
});
