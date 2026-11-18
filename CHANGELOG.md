# Changelog

## 0.2.0 · 2026-11-18

- `botshield.ai/approval`: the approval object carries `operation_hash`, the shared operation hash
  proposed in Poppy #71/#74, and the signed answer is bound to it. `@botshield/poppy` exports
  `operationHash()`, checked against the 17 published vectors.
- `@botshield/poppy`: BotShield is asked at most once per `checkEvery` (default 10 s) however often
  the agent repeats; a rate limit or outage leaves a request waiting instead of failing it.

## 0.1.0 · 2026-11-18

- First draft of `botshield.ai/approval` and `botshield.ai/human-presence`, tested end to end
  against a live BotShield environment.
