# @botshield/poppy

The Company's side of BotShield's extensions for the
[Personal Agent Protocol](https://personalagentprotocol.org) ("Poppy"), for Node.js. No runtime
dependencies. Server side only: it uses your BotShield secret key.

What the extensions are for, and how a request looks on the wire, is in the
[repository README](https://github.com/Bot-Shield/poppy-extensions#readme). This page is the package
guide.

```sh
npm install @botshield/poppy
```

## Before you start

- **Node.js 20 or later** to use the package. To run the tests and the reference files, 22.18 or
  later, because they run TypeScript directly.
- **A BotShield secret key with Gates API access**, from the Console. A `bs_dev_` key runs in the
  sandbox.
- **A Company that speaks Poppy 1.0.** These extensions sit behind your own Session and access token
  checks.
- **BotShield Verified accounts.** An account holder can be asked only once their account is
  BotShield Verified with you; [docs.botshield.ai](https://docs.botshield.ai) covers how a customer
  becomes verified, and `reference/company.ts` shows the step in a demo (`/account/link`).
- **For the BotShield Signal API (verified at each order):** an Action in the Console with the key
  `assistant`, and the name your requests are shown under. Your server reads the agent's name from
  the Poppy metadata at its `client_id`.
- **For approvals of an order or change:** an Action in the Console (its key, here `plan`).
- **For a Session with no signed-in account:** a Human Gate in the Console.

## BotShield Signal API: verified at each order

`AssistantGate` is the BotShield Signal API, for agentic commerce. The account holder approves an
agent once, with their passkey. At every order after that your server gets a fresh answer: **verified: true** (the agent is bound to a BotShield Verified customer) or **false**. On a match, nobody is asked. The
account holder can remove the agent in the BotShield app at any time, and the next check is no match.

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

verified: true says the agent is bound to a BotShield Verified customer. For the customer's approval of an
order's exact terms, use `AccountHolderApproval`, below.

### Decide when to ask (`onUnapproved`, from 0.3.0)

By default (`'ask'`), an agent that isn't approved starts the account holder's approval. With
`onUnapproved: 'signal'`, nobody is asked: `require()` returns `{ allowed: false, match: false }` for
an agent that was never approved or no longer matches, and your server decides. Decline with your
usual answer, use your own checks, or call `ask()` when you want the account holder asked.

```ts
const agents = new AssistantGate({ api, agent: 'yourcompany', onUnapproved: 'signal' });

const r = await agents.require({ account, assistant, orderRef, approvalId });
if (r.allowed) {
  // verified: true. Place the order.
} else if ('match' in r) {
  // No match, and nobody was asked. Decline, or ask the account holder:
  // const asked = await agents.ask({ account, assistant, orderRef, approvalId: null });
}
```

## The verified customer approved this order or change

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
async function changePlan(
  account: string,
  clientId: string,
  approvalId: string | null,
  plan: { id: string; name: string; price: string },
) {
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
    const done = await r.perform(async () => savePlan(account, plan.id));   // runs to completion at most once
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
[`reference/company.ts`](https://github.com/Bot-Shield/poppy-extensions/blob/main/reference/company.ts) is a runnable demo server built this way on `node:http`;
it takes the Session and the account from `X-Demo-*` headers.

## A Session with no signed-in account

The repository also carries `botshield.ai/human-presence` ([SPEC](https://github.com/Bot-Shield/poppy-extensions/blob/main/extensions/human-presence/SPEC.md)),
for a Session where no account is signed in yet. `HumanPresence` asks a person to confirm with their
passkey. It takes the verified Poppy Session, not an account, and it has no `perform`:

```ts
import { BotShieldApi, HumanPresence, PRESENCE_ID_HEADER, presenceResponse } from '@botshield/poppy';

const api = new BotShieldApi({ secretKey: process.env.BOTSHIELD_SECRET_KEY! });
const presence = new HumanPresence({ api, gate: 'signed-out' });   // the key of a Human Gate in the Console

async function confirmPerson(
  session: { client: string; sid: string; user: string },
  presenceId: string | null,
) {
  const r = await presence.require({ session, presenceId });     // presenceId: the BotShield-Presence-Id header, or null
  if (!r.passed) return presenceResponse(r.presence);            // { status: 403, headers, body }
  return { status: 200, headers: {}, body: { ok: true } };
}
```

## MCP servers

Return `approvalToolResult(r.approval)` or `presenceToolResult(r.presence)` from the tool. Each is a
tool error any MCP client can act on, with the object in `structuredContent`. The Personal Agent
repeats the call with the ID in `_meta` (`APPROVAL_ID_META`, `PRESENCE_ID_META`).

## Options

| Option | On | Default | What it does |
| --- | --- | --- | --- |
| `ttlSeconds` | `AccountHolderApproval`, `AssistantGate` | 600 | How long the account holder has to answer. 60 to 86400. |
| `passFor` | `HumanPresence` | 3600 | How long a pass covers the Session, in seconds. |
| `retryAfter` | all three | 5 | Seconds the Personal Agent is told to wait between repeats. |
| `checkEvery` | all three | 10 | While an answer is pending, ask BotShield at most once in this many seconds, however often the agent repeats. `AssistantGate`'s check at each order is never held back. |
| `store` | all three | in memory | Where requests are kept, and for `AssistantGate` the approved agents. The default is lost on restart; in production pass a `Store` on durable, shared storage. |
| `baseUrl`, `fetch` | `BotShieldApi` | `https://api.botshield.ai`, global `fetch` | For tests, or a runtime without a global `fetch`. |

## Errors

| Thrown | Meaning | Answer with |
| --- | --- | --- |
| `NotLinkedError` | Thrown by `AccountHolderApproval`: the account isn't BotShield Verified with you, and nobody was asked. `AssistantGate` throws `BotShieldError` with `code: 'not_linked'` for the same case. | Handle the action without the extension. |
| `StillPerformingError` | Another request is performing this action now. | 503, with `Retry-After: e.retryAfter`. |
| `BotShieldError` | BotShield refused the call. It carries `status` and a `code`, which can be `null`. | `isTransient(e)` is true for a rate limit or an outage: answer 503 and let the agent repeat. |
| `Error` | The input was invalid: 1 to 12 terms, a label of up to 40 characters, a value of up to 80, or a malformed `actionKey`. | Fix the call. |

## Run the reference and the tests

```sh
(cd packages/poppy && npm ci && npm test)                # Node 22.18 or later
```

The reference Company and agent run in two terminals, from the repository root:

```sh
BOTSHIELD_SECRET_KEY=bs_dev_YOUR_KEY node reference/company.ts
```

```sh
node reference/agent.ts link --account acct_demo_1                         # once: verify the demo account
node reference/agent.ts plan --account acct_demo_1 --plan unlimited-plus   # then ask for a plan change
```

The reference Company expects four things in the Console, each with an environment variable to name
your own: an Action `plan` (`DEMO_ACTION_KEY`), the name requests are shown under, `personal-agents`
(`DEMO_AGENT_NAME`), a gate `link` whose link setting is required (`DEMO_LINK_GATE`), and a Human Gate
`poppy-demo-presale` (`DEMO_PRESENCE_GATE`).

BotShield's API and Console are documented at [docs.botshield.ai](https://docs.botshield.ai/poppy/overview).
