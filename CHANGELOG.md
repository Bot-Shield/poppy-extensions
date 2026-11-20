# Changelog

## Unreleased

- `@botshield/poppy`: `AssistantGate` takes `onUnapproved: 'ask' | 'signal'`. `'signal'` asks
  nobody when the assistant isn't approved, whether the gate has never seen it or the check comes
  back no match, and returns `{ allowed: false, match: false }` for the Company to act on. The new
  `ask()` starts the account holder's approval when the Company chooses. **The default stays
  `'ask'`**, today's behaviour, so existing users see no change; `GateResult` gains the
  `{ allowed: false, match: false }` member, which code that switches exhaustively on it must
  handle. `botshield.ai/approval` section 9a steps 1 and 4 now say the Company decides when to ask.
- `demo/couchtour`: ticket orders on the BotShield Signal API (`POST /api/orders`, `placeOrder`), with
  `AssistantGate` in `'signal'` mode. The first order asks the account holder once ("Let Demo agent
  buy for you"); later orders are a silent Match. The simulated BotShield answers
  `gates-api/assistants/register` and `/check`, and its phone lists approved agents with Remove. Debug
  has "Try as an unknown agent". The presale chip is gone (the presale still works). Every refusal
  reaches the agent as one plain `declined`, with the reason in the trace. The phone change has its
  own Action key (`DEMO_PHONE_ACTION`, now `phone`). The demo key leaves the address bar after it's read.

- `demo/couchtour` (poppy-demo.couchtour.app) rebuilt as a live, Atlas-style demo. A Personal Agent
  driven by Claude makes real Poppy requests to the demo Couch Tour, and the page shows each one:
  discovery, Sessions with delegated keys, Direct Sign-In (PKCE) or Mediated Sign-In by phone, the
  APIs, and the BotShield steps. Couch Tour is now a signed-in Poppy Company: protected resource and
  issuer metadata, an OAuth authorization server, Session verification, a Company Agent, and a new
  operation, changing the phone number on file, approved by the account holder (`update_phone` in
  MCP too). Public visitors get a simulated BotShield inside the Worker; the demo key switches to
  live. The recorded replays are gone. The extensions' wire format is unchanged.

## 0.2.1 · 2026-11-18

- `botshield.ai/human-presence`: the presence object no longer carries `qr_code_uri`; that address
  didn't serve an image. An agent on a computer makes a QR code of `verification_uri` itself.
- README: the example agent name is a valid Console agent name.

## 0.2.0 · 2026-11-18

- Fix: `@botshield/poppy` 0.1.0 called the global `fetch` unbound, which throws "Illegal invocation"
  on Cloudflare Workers. It now works there (found building the Couch Tour demo).
- `demo/couchtour`: a demo Couch Tour on Cloudflare Workers with `poppy.json`, an API and an MCP
  server (`request_refund`, `enter_presale`), tested against a live BotShield environment.

- `botshield.ai/approval` section 9a: the purchase gate. The account holder approves an assistant
  once (named from its Poppy metadata); the Company checks fresh at every checkout; the person can
  remove it. `@botshield/poppy` adds `AssistantGate`.

- `botshield.ai/approval`: the approval object carries `operation_hash`, the shared operation hash
  proposed in Poppy #71/#74, and the signed answer is bound to it. `@botshield/poppy` exports
  `operationHash()`, checked against the 17 published vectors.
- `@botshield/poppy`: BotShield is asked at most once per `checkEvery` (default 10 s) however often
  the agent repeats; a rate limit or outage leaves a request waiting instead of failing it.

## 0.1.0 · 2026-11-18

- First draft of `botshield.ai/approval` and `botshield.ai/human-presence`, tested end to end
  against a live BotShield environment.
