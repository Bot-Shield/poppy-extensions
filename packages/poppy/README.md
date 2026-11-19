# @botshield/poppy

The Company's side of BotShield's extensions for the [Personal Agent Protocol](https://personalagentprotocol.org):

- `AccountHolderApproval`: [`botshield.ai/approval`](../../extensions/approval/SPEC.md), the account holder approves exact terms with their passkey.
- `HumanPresence`: [`botshield.ai/human-presence`](../../extensions/human-presence/SPEC.md), a person confirms with their passkey, counted once at your gate.

Node.js 20 or later, no runtime dependencies. Server side only: it uses your BotShield secret key.
The [repository README](https://github.com/Bot-Shield/poppy-extensions#readme) has a quickstart for each, the options and their
defaults, the errors to handle, and how to run the reference Company.

The default store keeps state in memory. With more than one server, pass a `store` that implements
the `Store` interface on shared storage.
