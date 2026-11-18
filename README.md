# BotShield extensions for Poppy

[![npm](https://img.shields.io/npm/v/@botshield/poppy)](https://www.npmjs.com/package/@botshield/poppy)

Two extensions for the [Personal Agent Protocol](https://personalagentprotocol.org) ("Poppy"), so a
Company can get a real person's yes when a personal agent is doing the asking.

| Extension | What the Company gets | Spec |
| --- | --- | --- |
| `botshield.ai/approval` | The **account holder** approved these **exact terms**, on their own phone, with their passkey. A signed answer, good once. | [SPEC](extensions/approval/SPEC.md) |
| `botshield.ai/human-presence` | A **real person** was present, counted once at the Company's gate (for example one entry per person), without learning who they are. | [SPEC](extensions/human-presence/SPEC.md) |

Both follow Poppy 1.0's rules for third-party extensions (spec 3.3): they're named under a domain we
control, they're optional, and a side that doesn't support them ignores them.

## Why

Poppy lets a person's agent find a Company, sign in with scopes, and act. For an action that needs
approval, Poppy's Operations extension relies on the agent's statement that the person approved;
Operations 8.1 says that "doesn't show that the User approved", and points the Company to its own
channel for actions where it wants to see the person approve. Signed approvals and a verified human
signal are open topics on Poppy's roadmap
([#25](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/25),
[#71](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/71),
[#74](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/74)).

These extensions are that channel, the same for every agent:

1. The agent asks the Company to do something.
2. The Company answers **403** and asks the person through BotShield. Nothing is done yet.
3. The person answers on their phone, in the BotShield app, with their passkey.
4. The agent repeats its request. The Company checks BotShield's signed answer and acts, **once**.

The agent can't approve, and never handles the person's answer. It works with agents that don't know
the extensions too: they see an ordinary error saying what to do, and the action stays safe.

## How it looks

```http
POST /plans/change HTTP/1.1
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
    "retry_after": 5
  }
}
```

The agent tells the person to check the BotShield app, then repeats the request with
`BotShield-Approval-Id: apv_8Hq2Lk`. Once the account holder approves, the plan changes.

## For Companies: `@botshield/poppy`

The [package](packages/poppy) does the Company's side in Node.js, with no runtime dependencies.

```sh
npm install @botshield/poppy
```

```ts
import { BotShieldApi, AccountHolderApproval, approvalResponse, NotLinkedError } from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
const approvals = new AccountHolderApproval({ api, agent: 'yourcompany', actionKey: 'plan' });

app.post('/plans/change', async (req, res) => {
  // After your Poppy Session and access token checks (spec 5.3, 7):
  const r = await approvals.require({
    account: req.account.id,                       // your own reference for the signed-in account
    client: req.poppy.clientId,                    // the Personal Agent's client_id
    approvalId: req.get('BotShield-Approval-Id'),
    meaning: { plan: req.body.plan },
    summary: `Change your plan to **${plan.name}**, from your next bill.`,
    terms: [
      { label: 'Plan', value: plan.name },
      { label: 'Total', value: `${plan.price} a month` },
    ],
  });
  if (!r.approved) {
    const out = approvalResponse(r.approval);
    return res.status(out.status).set(out.headers).json(out.body);
  }
  res.json(await r.perform(() => changePlan(req.account.id, plan)));   // at most once
});
```

`HumanPresence` works the same way for a gate. MCP servers use `approvalToolResult` and
`presenceToolResult`, which return a tool error any MCP client can act on.

**What you set up in the BotShield Console:** a secret key with Gates API access; for approvals, an
Action (its key, here `plan`) and an agent name the request is shown under; for presence, a Human
Gate with its per-person rule. A `bs_dev_` key runs everything in the sandbox.

## Status

Draft, version 1 of each extension, written against Poppy 1.0, and **tested end to end against a
live BotShield environment** with the [reference Company and agent](reference) (2026-11-18):

| Run | Result |
| --- | --- |
| Presale entry, person confirms with their passkey | Entry recorded |
| Same person, new Session, same presale | Refused: one entry per person |
| A gate that needs a verified phone number, account without one | Refused |
| Plan change, account holder approves the exact terms in the BotShield app | Plan changed, once |

Feedback is welcome in this repository's issues. We plan to propose the extensions in the Poppy
repository, on the threads above.

## License

[Apache 2.0](LICENSE). The names BotShield and Poppy, and their logos, are not covered.
