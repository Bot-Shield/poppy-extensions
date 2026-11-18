import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HumanPresence, presenceResponse, presenceToolResult, trustedPresenceLinks } from '../src/presence.ts';
import { BotShieldApi } from '../src/api.ts';
import { declaredExtensions, declares } from '../src/poppy.ts';
import { fakeBotShield, type FakeState } from './fakeBotShield.ts';

const session = { client: 'https://agent.example/agent.json', sid: 'Yx2b7Qd_Kp8mR3vT1nWc4A', user: 'usr_Q7c1vK' };

function setup() {
  const state: FakeState = { linked: true, calls: [] };
  const api = new BotShieldApi({ secretKey: 'bs_production_test', fetch: fakeBotShield(state) });
  return { state, presence: new HumanPresence({ api, gate: 'presale-dec-1' }) };
}

test('the first request opens a check with a BotShield link, and performs nothing', async () => {
  const { presence } = setup();
  const r = await presence.require({ session });
  assert.equal(r.passed, false);
  if (r.passed) return;
  assert.equal(r.presence.state, 'requested');
  assert.equal(r.presence.verification_uri, 'https://app.botshield.ai/verify?request_id=req-1');
  assert.ok(trustedPresenceLinks(r.presence));
  assert.equal(presenceResponse(r.presence).body.error, 'human_presence_required');
  assert.match(presenceToolResult(r.presence).content[0].text, /app\.botshield\.ai/);
});

test('passed: the token is checked once and the Session is covered', async () => {
  const { state, presence } = setup();
  const first = await presence.require({ session });
  assert.ok(!first.passed);
  state.check!.status = 'completed';
  state.check!.token = 'tok_pass';
  assert.deepEqual(await presence.require({ session, presenceId: first.presence.presence_id }), { passed: true });
  assert.deepEqual(await presence.require({ session }), { passed: true }, 'the pass covers later requests');
  assert.equal(state.calls.filter((c) => c === 'sdk/verify-token').length, 1);
});

test("the gate's per-person rule refusing is reported as refused", async () => {
  const { state, presence } = setup();
  const first = await presence.require({ session });
  assert.ok(!first.passed);
  state.check!.status = 'failed';
  state.check!.reason = 'pass_limit_reached';
  const r = await presence.require({ session, presenceId: first.presence.presence_id });
  assert.ok(!r.passed);
  assert.equal(r.presence.state, 'refused');
  assert.equal(r.presence.verification_uri, undefined);
});

test("another Session can't use the check", async () => {
  const { state, presence } = setup();
  const first = await presence.require({ session });
  assert.ok(!first.passed);
  state.check!.status = 'completed';
  state.check!.token = 'tok_pass';
  const other = await presence.require({ session: { ...session, sid: 'other' }, presenceId: first.presence.presence_id });
  assert.equal(other.passed, false);
});

test('host checks refuse links that are not BotShield', () => {
  assert.equal(trustedPresenceLinks({ verification_uri: 'https://app.botshield.ai.evil.example/verify' }), false);
  assert.equal(trustedPresenceLinks({ verification_uri: 'http://app.botshield.ai/verify' }), false);
  assert.equal(trustedPresenceLinks({ verification_uri: 'https://app.botshield.ai/verify', qr_code_uri: 'https://evil.example/qr' }), false);
});

test('Poppy-Extensions parsing', () => {
  const h = '"operations";v="3", "botshield.ai/approval";v="1", "botshield.ai/human-presence";v="1"';
  assert.deepEqual([...declaredExtensions(h)], [['operations', '3'], ['botshield.ai/approval', '1'], ['botshield.ai/human-presence', '1']]);
  assert.ok(declares(h, 'botshield.ai/approval'));
  assert.ok(!declares(h, 'botshield.ai/approval', '2'));
  assert.equal(declaredExtensions('not a list').size, 0);
  assert.equal(declaredExtensions(undefined).size, 0);
});
