# BotShield extensions for Poppy

[![npm](https://img.shields.io/npm/v/@botshield/poppy)](https://www.npmjs.com/package/@botshield/poppy)

Extensions for the [Personal Agent Protocol](https://personalagentprotocol.org) ("Poppy"), so a
Company knows that the agent placing an order **belongs to a verified customer**.

BotShield connects a customer's account at a Company to a passkey on the customer's own phone; such
an account is BotShield Verified. Poppy signs a customer's agent in to an account at the Company.
These extensions add the account holder's own answer, given on their phone with that passkey.

| The Company knows | How | With |
| --- | --- | --- |
| **The agent belongs to a verified customer.** | The account holder approves the agent once, on their own phone, with their passkey. At every order the Company asks BotShield, fresh: is this still that customer's agent? The BotShield Signal API answers verified: true or false. | `botshield.ai/approval` · [section 9a](extensions/approval/SPEC.md#9a-approving-an-assistant-the-purchase-gate) |
| **The verified customer approved this order or change.** | The account holder approves the **exact terms**, on their own phone, with their passkey. A signed answer, good once. | `botshield.ai/approval` · [SPEC](extensions/approval/SPEC.md) |

BotShield is not the checkout, the wallet or the card: the Company takes the order, and the payment
rail takes the payment. The agent never receives the account holder's identity.

Two extensions: `botshield.ai/approval`, for both rows above, and `botshield.ai/human-presence`, for a
Session with no signed-in account. Here "agent" means the customer's Personal Agent; the specs and
the package also call it the assistant.

The extensions follow Poppy 1.0's rules for third-party extensions (spec 3.3): they're named under a
domain we control, they're optional, and a side that doesn't support them ignores them.

## Why

An agent can say its customer approved. A Company cannot check that.

For an action that is hard to undo, such as a payment, a cancellation or a change of plan, the
Company needs the customer's own decision on the exact terms, in a form it can verify. These
extensions capture it. The account holder reads the terms on their own phone and approves with their
passkey; the passkey signs what was shown, and BotShield gives the Company a signed answer for that
one request, good once.

BotShield is independent of the Company and of the agent, so the signed result stands on its own.
The answer is given outside the agent's reach, and the signed result comes from a party other than
the one asking. BotShield never asks for an ID.

Poppy names the gap. Its Operations extension relies on the agent's statement that the person
approved, and Operations 8.1 says this "doesn't show that the User approved". Signed approvals are an
open topic on Poppy's roadmap
([#71](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/71),
[#74](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/74)).

The flow is the same for every agent:

1. The agent asks the Company to do something.
2. The Company answers **403** and asks the account holder through BotShield. Nothing is done yet.
3. The account holder answers on their phone, in the BotShield app, with their passkey.
4. The agent repeats its request. The Company checks BotShield's signed answer and acts, **once**.

The agent can't approve, and never handles the account holder's answer. The flow also works with
agents that don't know the extensions: they see an ordinary error saying what to do, and the action
stays safe.

## How it looks

```http
POST /plan/change HTTP/1.1
Poppy-Extensions: "botshield.ai/approval";v="1"

HTTP/1.1 403 Forbidden
Retry-After: 5

{
  "error": "account_holder_approval_required",
  "approval": {
    "approval_id": "apv_8Hq2Lk",
    "state": "requested",
    "summary": "Change your plan to **Unlimited Plus**, from your next bill.",
    "terms": [
      { "label": "Plan", "value": "Unlimited Plus" },
      { "label": "Total", "value": "$95.00 a month" }
    ],
    "expires_at": "2026-11-18T17:05:00Z",
    "retry_after": 5,
    "operation_hash": "29gnTv_ZQpd-Q5RTt9C1o_clGWFrn0Fg3xIblKXQ5EQ"
  }
}
```

The agent tells the customer to check the BotShield app, then repeats the request with
`BotShield-Approval-Id: apv_8Hq2Lk`. Once the account holder approves, the plan changes.

## For Companies: `@botshield/poppy`

The [package](packages/poppy) does the Company's side in Node.js, with no runtime dependencies.

```sh
npm install @botshield/poppy
```

`AssistantGate` asks the account holder once whether an agent may order for them, then checks at
every order. The account holder can remove the agent in the BotShield app at any time, and the next
check answers false.

```ts
import { BotShieldApi, BotShieldError, AssistantGate, approvalResponse } from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
// `agent` here is your Company's name in the Console, shown on the request. Needs an Action with the key `assistant`.
const agents = new AssistantGate({ api, agent: 'yourcompany' });

// Call this when an order is placed, after your Poppy Session and access token checks (spec 5.3, 7).
// `account` is your own reference for the signed-in account; `iss` and `sub` are the verified Session's.
async function checkAgent(
  account: string,
  session: { iss: string; sub: string },
  orderRef: string,
  approvalId: string | null,
) {
  try {
    const r = await agents.require({
      account,
      assistant: { clientId: session.iss, userId: session.sub },
      orderRef,
      approvalId,
    });
    if (r.allowed) return { status: 200, headers: {}, body: { checked_at: r.checkedAt, check_id: r.checkId } };
    if ('refused' in r) return { status: 403, headers: {}, body: { error: r.refused } };   // the agent's metadata gave no name
    return approvalResponse(r.approval);                                                  // 403: the account holder is asked
  } catch (e) {
    if (e instanceof BotShieldError && e.code === 'not_linked') {
      // The account isn't BotShield Verified with you, so nobody was asked.
      return { status: 403, headers: {}, body: { error: 'not_available' } };
    }
    throw e;
  }
}
```

A match says whose agent it is. For the customer's approval of an order's exact terms, use
`AccountHolderApproval`, below.

The [package guide](packages/poppy/README.md) has the rest: what to set up first, the approval of an
order or change, a Session with no signed-in account, MCP servers, the options and their defaults,
the errors to handle, and how to run the reference Company and agent. BotShield's API and Console are
documented at [docs.botshield.ai](https://docs.botshield.ai/poppy/overview), and the model behind this is
at [botshield.ai/agent-identity](https://botshield.ai/agent-identity).

## Status

A draft. Each extension is at version 1, written against Poppy 1.0. While it is a draft its response
shape can change, and [CHANGELOG.md](CHANGELOG.md) records each change. The package follows semantic
versioning.

Feedback is welcome in this repository's issues.

## License

[Apache 2.0](LICENSE). The license grants no rights to the BotShield name or logo.
