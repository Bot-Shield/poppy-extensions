# BotShield extensions for Poppy

[![npm](https://img.shields.io/npm/v/@botshield/poppy)](https://www.npmjs.com/package/@botshield/poppy)

Extensions for the [Personal Agent Protocol](https://personalagentprotocol.org) ("Poppy"), so a
Company knows that the agent placing an order **belongs to a verified customer**.

Poppy gets the agent in the door. Without these extensions, the Company has only the agent's word
for whose agent it is. With them, the customer answers for the agent: the account holder, whose
account at the Company is BotShield Verified, confirms on their own phone with a passkey.

| The Company knows | How | With |
| --- | --- | --- |
| **The agent belongs to a verified customer.** | The account holder approves the agent once, on their own phone, with their passkey. At every order the Company asks BotShield, fresh: is this still that customer's agent? Match, or no match. | `botshield.ai/approval`, [section 9a](extensions/approval/SPEC.md#9a-approving-an-assistant-the-purchase-gate) |
| **The verified customer approved this order or change.** | The account holder approves the **exact terms**, on their own phone, with their passkey. A signed answer, good once. | `botshield.ai/approval` · [SPEC](extensions/approval/SPEC.md) |

BotShield is not the checkout, the wallet or the card: the Company takes the order, and the payment
rail takes the payment. The agent never receives the account holder's identity.

The extensions follow Poppy 1.0's rules for third-party extensions (spec 3.3): they're named under a
domain we control, they're optional, and a side that doesn't support them ignores them.

## Why

Poppy lets a person's agent find a Company, sign in with scopes, and act. For an action that needs
approval, Poppy's Operations extension relies on the agent's statement that the person approved;
Operations 8.1 says that "doesn't show that the User approved", and points the Company to its own
channel for actions where it wants to see the person approve. Signed approvals are an open topic on
Poppy's roadmap
([#71](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/71),
[#74](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/74)).

These extensions are that channel, the same for every agent:

1. The agent asks the Company to do something.
2. The Company answers **403** and asks the account holder through BotShield. Nothing is done yet.
3. The account holder answers on their phone, in the BotShield app, with their passkey.
4. The agent repeats its request. The Company checks BotShield's signed answer and acts, **once**.

The agent can't approve, and never handles the account holder's answer. It works with agents that don't know
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
    "retry_after": 5,
    "operation_hash": "fUO4lcit8LvKJK4qyu-uKdVLC_PkSWzLkD0k0IcJeU4"
  }
}
```

The agent tells its user to check the BotShield app, then repeats the request with
`BotShield-Approval-Id: apv_8Hq2Lk`. Once the account holder approves, the plan changes.

## For Companies: `@botshield/poppy`

The [package](packages/poppy) does the Company's side in Node.js, with no runtime dependencies.

```sh
npm install @botshield/poppy
```

### The agent belongs to a verified customer

`AssistantGate` asks the account holder once whether an agent may order for them, then checks at
every order. The account holder can remove the agent in the BotShield app at any time, and the next
check is no match.

```ts
import { BotShieldApi, AssistantGate, approvalResponse } from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
const agents = new AssistantGate({ api, agent: 'yourcompany' });   // needs an Action with the key `assistant`

// Call this when an order is placed, after your Poppy Session checks. `iss` and `sub` are the verified Session's.
async function checkAgent(account: string, session: { iss: string; sub: string }, orderRef: string, approvalId: string | null) {
  const r = await agents.require({ account, assistant: { clientId: session.iss, userId: session.sub }, orderRef, approvalId });
  if (r.allowed) return { status: 200, headers: {}, body: { checked_at: r.checkedAt, check_id: r.checkId } };
  if ('refused' in r) return { status: 403, headers: {}, body: { error: r.refused } };   // the agent's metadata gave no name
  return approvalResponse(r.approval);                                                  // 403: the account holder is asked, once
}
```

A match says whose agent it is. For the customer's approval of an order's exact terms, use
`AccountHolderApproval`, below.

### The verified customer approved this order or change

`AccountHolderApproval` asks the account holder to approve the exact terms of one action.

```ts
import {
  BotShieldApi, AccountHolderApproval, NotLinkedError, StillPerformingError,
  APPROVAL_ID_HEADER, approvalResponse,
} from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
const approvals = new AccountHolderApproval({ api, agent: 'yourcompany', actionKey: 'plan' });

// Call this from your route, after your Poppy Session and access token checks (spec 5.3, 7).
// `account` is your own reference for the signed-in account; `clientId` is the Personal Agent's client_id.
async function changePlan(account: string, clientId: string, approvalId: string | null, plan: { id: string; name: string; price: string }) {
  try {
    const r = await approvals.require({
      account,
      client: clientId,
      approvalId,                                   // the BotShield-Approval-Id header, or null
      meaning: { plan: plan.id },                   // what is being asked, so a different request isn't matched
      summary: `Change your plan to **${plan.name}**, from your next bill.`,
      terms: [
        { label: 'Plan', value: plan.name },
        { label: 'Total', value: `${plan.price} a month` },
      ],
    });
    if (!r.approved) return approvalResponse(r.approval);          // { status: 403, headers, body }
    const done = await r.perform(async () => savePlan(account, plan.id));   // runs at most once
    return { status: 200, headers: {}, body: done };
  } catch (e) {
    if (e instanceof NotLinkedError) {
      // The account isn't BotShield Verified with you, so nobody was asked. Handle the action another way.
      return { status: 403, headers: {}, body: { error: 'not_available' } };
    }
    if (e instanceof StillPerformingError) {
      return { status: 503, headers: { 'Retry-After': String(e.retryAfter) }, body: { error: 'in_progress' } };
    }
    throw e;
  }
}
```

`savePlan` is yours. Read the header with `APPROVAL_ID_HEADER` (`BotShield-Approval-Id`). The function
returns a status, headers and a body, so it fits any framework;
[`reference/company.ts`](reference/company.ts) is a complete server built this way on `node:http`.

### A Session with no signed-in account

The repository also carries `botshield.ai/human-presence` ([SPEC](extensions/human-presence/SPEC.md)),
for a Session where no account is signed in yet. `HumanPresence` asks a person to confirm with their
passkey. It takes the verified Poppy Session, not an account, and it has no `perform`:

```ts
import { BotShieldApi, HumanPresence, PRESENCE_ID_HEADER, presenceResponse } from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
const presence = new HumanPresence({ api, gate: 'signed-out' });   // the key of a Human Gate in the Console

async function confirmPerson(session: { client: string; sid: string; user: string }, presenceId: string | null) {
  const r = await presence.require({ session, presenceId });     // presenceId: the BotShield-Presence-Id header, or null
  if (!r.passed) return presenceResponse(r.presence);            // { status: 403, headers, body }
  return { status: 200, headers: {}, body: { ok: true } };
}
```

### MCP servers

Return `approvalToolResult(r.approval)` or `presenceToolResult(r.presence)` from the tool. Each is a
tool error any MCP client can act on, with the object in `structuredContent`. The Personal Agent
repeats the call with the ID in `_meta` (`APPROVAL_ID_META`, `PRESENCE_ID_META`).

### Before you start

- **Node.js 20 or later** to use the package. To run the tests and the reference files, 22.18 or
  later, because they run TypeScript directly.
- **A BotShield secret key with Gates API access**, from the Console. A `bs_dev_` key runs everything
  in the sandbox.
- **For approvals:** an Action in the Console (its key, here `plan`), and an agent name the request
  is shown under. The account has to be BotShield Verified with you before its holder can be asked;
  `reference/company.ts` shows that one-time step (`/account/link`).
- **To know the agent belongs to a verified customer:** an Action with the key `assistant`.
- **For a Session with no signed-in account:** a Human Gate in the Console.
- **A Company that speaks Poppy 1.0.** These extensions sit behind your own Session and token checks.

### Options

| Option | On | Default | What it does |
| --- | --- | --- | --- |
| `ttlSeconds` | `AccountHolderApproval`, `AssistantGate` | 600 | How long the account holder has to answer. 60 to 86400. |
| `passFor` | `HumanPresence` | 3600 | How long a pass covers the Session, in seconds. |
| `retryAfter` | all three | 5 | Seconds the Personal Agent is told to wait between repeats. |
| `checkEvery` | all three | 10 | Ask BotShield at most once in this many seconds per request, however often the agent repeats. |
| `store` | all three | in memory | Where requests are kept. With more than one server, pass a `Store` on shared storage. |
| `baseUrl`, `fetch` | `BotShieldApi` | `https://api.botshield.ai`, global `fetch` | For tests, or a runtime without a global `fetch`. |

### Errors

| Thrown | Meaning | Answer with |
| --- | --- | --- |
| `NotLinkedError` | The account isn't BotShield Verified with you. Nobody was asked. | Handle the action without the extension. |
| `StillPerformingError` | Another request is performing this action now. | 503, with `Retry-After: e.retryAfter`. |
| `BotShieldError` | BotShield refused the call. It carries `status` and `code`. | `isTransient(e)` is true for a rate limit or an outage: answer 503 and let the agent repeat. |

### Run the reference and the tests

```sh
(cd packages/poppy && npm ci && npm test)                        # Node 22.18 or later
BOTSHIELD_SECRET_KEY=bs_dev_… node reference/company.ts          # the reference Company
node reference/agent.ts plan --account acct_demo_1 --plan unlimited-plus   # the reference agent
```

BotShield's API and Console are documented at [docs.botshield.ai](https://docs.botshield.ai/poppy/overview).

## Compatibility

Written against Poppy 1.0. Each extension is version 1 and a draft: its response shape can still
change, and a change that breaks an implementation gets a new extension version (Poppy spec 3.3).
The package follows semantic versioning; [CHANGELOG.md](CHANGELOG.md) lists both.

## Status

Tested end to end against a live BotShield environment with the
[reference Company and agent](reference), on 2026-11-18:

| Run | Result |
| --- | --- |
| Plan change; the account holder approves the exact terms in the BotShield app | Plan changed, once |
| A person confirms with their passkey at a Human Gate | Passed |
| The same person, a new Session, at a gate that allows one pass per person | Refused |
| A gate that needs a verified phone number; an account without one | Refused |

Feedback is welcome in this repository's issues. We plan to propose the extensions in the Poppy
repository, on the threads above.

## Pricing

The API is free, and BotShield is free for a Company's first 1,000 monthly active Verified Accounts.

## License

[Apache 2.0](LICENSE). The names BotShield and Poppy, and their logos, are not covered.

BotShield is not affiliated with or endorsed by the authors of the Personal Agent Protocol.
