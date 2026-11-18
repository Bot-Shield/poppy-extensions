# Changelog

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
