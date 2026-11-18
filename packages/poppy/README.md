# @botshield/poppy

The Company's side of BotShield's extensions for the [Personal Agent Protocol](https://personalagentprotocol.org):

- `AccountHolderApproval`: [`botshield.ai/approval`](../../extensions/approval/SPEC.md), the account holder approves exact terms with their passkey.
- `HumanPresence`: [`botshield.ai/human-presence`](../../extensions/human-presence/SPEC.md), a real person is present, counted once at your gate.

Node.js 20 or later, no runtime dependencies. Server side only: it uses your BotShield secret key.
See the [repository README](../../README.md) for an example.

The default store keeps state in memory. With more than one server, pass a `store` that implements
the `Store` interface on shared storage.
