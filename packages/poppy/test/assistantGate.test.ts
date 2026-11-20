import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantGate } from '../src/assistantGate.ts';
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
