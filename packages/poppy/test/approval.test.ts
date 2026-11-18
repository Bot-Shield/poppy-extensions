import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountHolderApproval, NotLinkedError, StillPerformingError, approvalResponse, approvalToolResult } from '../src/approval.ts';
import { BotShieldApi } from '../src/api.ts';
import { fakeBotShield, type FakeState } from './fakeBotShield.ts';

const terms = [
  { label: 'Plan', value: 'Unlimited Plus' },
  { label: 'Total', value: '$95.00 a month' },
];
const ask = { account: 'acct_42', client: 'https://agent.example/agent.json', meaning: { plan: 'unlimited-plus' }, summary: 'Change your plan to **Unlimited Plus**', terms };

function setup(linked = true) {
  const state: FakeState = { linked, calls: [] };
  const api = new BotShieldApi({ secretKey: 'bs_production_test', fetch: fakeBotShield(state) });
  return { state, approvals: new AccountHolderApproval({ api, agent: 'Poppy', actionKey: 'plan' }) };
}

test('the first request asks the account holder and performs nothing', async () => {
  const { state, approvals } = setup();
  const r = await approvals.require(ask);
  assert.equal(r.approved, false);
  if (r.approved) return;
  assert.equal(r.approval.state, 'requested');
  assert.match(r.approval.approval_id, /^apv_[A-Za-z0-9_-]+$/);
  assert.deepEqual(r.approval.terms, terms);
  assert.equal(r.approval.retry_after, 5);
  assert.match(state.action!.act, /^plan:[A-Za-z0-9_-]{43}$/);
  assert.equal(state.action!.act, `plan:${r.approval.operation_hash}`, 'the signed act names the shared operation hash');
  const http = approvalResponse(r.approval);
  assert.equal(http.status, 403);
  assert.equal(http.headers['Retry-After'], '5');
  assert.equal(http.body.error, 'account_holder_approval_required');
  assert.match(approvalToolResult(r.approval).content[0].text, /BotShield app/);
});

test('a repeat while waiting says requested again, and asks no one twice', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  const again = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.ok(!again.approved);
  assert.equal(again.approval.approval_id, first.approval.approval_id);
  assert.equal(state.calls.filter((c) => c === 'gates-api/actions/request').length, 1);
});

test('approved: the token is checked once and the action runs at most once', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  state.action!.status = 'approved';
  state.action!.token = 'tok_approved';
  let runs = 0;
  const r1 = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.ok(r1.approved);
  assert.equal(await r1.perform(async () => ++runs), 1);
  const r2 = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.ok(r2.approved);
  assert.equal(await r2.perform(async () => ++runs), 1, 'the first result, not a second run');
  assert.equal(runs, 1);
  assert.equal(state.calls.filter((c) => c === 'sdk/verify-token').length, 1);
});

test('a token for another act is not an approval', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  state.action!.status = 'approved';
  state.action!.token = 'tok_approved';
  state.action!.act = 'plan:something-else';
  const r = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.equal(r.approved, false);
});

test('declined and expired perform nothing', async () => {
  for (const [status, state] of [['denied', 'declined'], ['expired', 'expired']] as const) {
    const s = setup();
    const first = await s.approvals.require(ask);
    assert.ok(!first.approved);
    s.state.action!.status = status;
    const r = await s.approvals.require({ ...ask, approvalId: first.approval.approval_id });
    assert.ok(!r.approved);
    assert.equal(r.approval.state, state);
    assert.equal(r.approval.retry_after, undefined);
  }
});

test('a different request, account or Personal Agent never uses the approval', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  state.action!.status = 'approved';
  state.action!.token = 'tok_approved';
  for (const other of [
    { ...ask, meaning: { plan: 'basic' } },
    { ...ask, account: 'acct_99' },
    { ...ask, client: 'https://other.example/agent.json' },
    { ...ask, terms: [{ label: 'Total', value: '$1.00' }] },
  ]) {
    const r = await approvals.require({ ...other, approvalId: first.approval.approval_id });
    assert.equal(r.approved, false);
    if (!r.approved) assert.notEqual(r.approval.approval_id, first.approval.approval_id);
  }
});

test('an account not linked to BotShield: nothing is sent, the Company falls back', async () => {
  const { approvals } = setup(false);
  await assert.rejects(approvals.require(ask), NotLinkedError);
});

test('while the action runs, a second perform answers 503', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  state.action!.status = 'approved';
  state.action!.token = 'tok_approved';
  const r = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.ok(r.approved);
  let release!: () => void;
  const running = r.perform(() => new Promise<string>((res) => (release = () => res('done'))));
  await assert.rejects(r.perform(async () => 'twice'), StillPerformingError);
  release();
  assert.equal(await running, 'done');
});

test('terms are checked before anything is sent', async () => {
  const { state, approvals } = setup();
  await assert.rejects(approvals.require({ ...ask, terms: [] }), /1 to 12 rows/);
  await assert.rejects(approvals.require({ ...ask, terms: [{ label: 'x'.repeat(41), value: 'y' }] }), /label/);
  assert.equal(state.calls.length, 0);
});

test('repeats inside checkEvery do not call BotShield again', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  for (let i = 0; i < 5; i++) await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.equal(state.calls.filter((c) => c === 'gates-api/actions/request-status').length, 1);
});

test('a rate limit decides nothing: the request stays requested', async () => {
  const { state, approvals } = setup();
  const first = await approvals.require(ask);
  assert.ok(!first.approved);
  state.rateLimited = true;
  const r = await approvals.require({ ...ask, approvalId: first.approval.approval_id });
  assert.ok(!r.approved);
  assert.equal(r.approval.state, 'requested');
});

test('the default fetch is called bound, so it works on Cloudflare Workers', () => {
  const src = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(src, /this\.doFetch = opts\.fetch \?\? \(\(input, init\) => fetch\(input, init\)\)/);
});
