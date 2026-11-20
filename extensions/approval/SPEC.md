# `botshield.ai/approval` · version 1

**Status:** draft · **Builds on:** [Personal Agent Protocol 1.0](https://personalagentprotocol.org/docs/1.0/spec) · **License:** Apache 2.0

The account holder approves one exact action on their own phone, with their passkey, and the
Company receives a signed answer for it. The Personal Agent asks for the action. It can't approve
it.

## 1. The problem

A Personal Agent asks a Company to do something that is hard to undo: change a plan, add a payee,
send an order somewhere new. The Company wants the holder of the account to say yes to these exact
terms.

Under the [Operations extension](https://personalagentprotocol.org/docs/1.0/extensions/operations),
an approval is the Personal Agent's statement that the User approved. Operations 8.1 says plainly
that this "doesn't show that the User approved". For actions like these, Operations 8.1 tells the
Company not to return an operation and to have the User confirm in the Company's own channel. This
extension is that channel, defined so every Personal Agent can handle it the same way:

- The Company sends the request for approval to the account holder through BotShield.
- The account holder approves on their phone, in the BotShield app, with their passkey. They see the
  Company's name and the terms.
- BotShield gives the Company a signed answer for that one request. It names no person.
- The Personal Agent tells the User where to answer, waits, and repeats its request. Nothing it
  sends counts as approval.

**Example.** A customer asks their assistant to move their phone plan to Unlimited Plus. The carrier
answers that the account holder must approve this, and sends the request to the account holder's
phone through BotShield. The account holder reads "Unlimited Plus · $95.00 a month · from your next
bill" and approves with their passkey. The assistant repeats its request, and the carrier changes
the plan, once.

## 2. Relationship to Operations

This extension doesn't use operations, and doesn't change them. For a given action, a Company
either returns an operation (Operations) or asks the account holder (this extension), never both.
A Company can offer both extensions, for different actions.

## 3. Who can be asked

Only the holder of an account at the Company who has linked it to BotShield (a BotShield Verified
account). The Company knows its own account from the Session's access token. A Company MUST NOT
use this extension in a signed-out Session, or for an account that isn't linked. It handles those
as it would without the extension: it asks the User to sign in ([spec
7](https://personalagentprotocol.org/docs/1.0/spec#apis)), refuses, or offers the action another
way.

## 4. Advertising and declaring

A Company lists the extension in `poppy.json` ([spec
3.3](https://personalagentprotocol.org/docs/1.0/spec#extensions)). Version 1 has no other fields.

```json
"extensions": {
  "botshield.ai/approval": [{ "version": "1" }]
}
```

A Personal Agent that supports it declares it in `Poppy-Extensions`:

```http
Poppy-Extensions: "botshield.ai/approval";v="1"
```

Support means the Personal Agent handles the response in section 5 as section 6 describes, on every
interface it uses with the Company.

## 5. Asking for approval

The Company performs nothing. It sends the request for approval to the account holder through
BotShield ([section 9](#9-the-company-and-botshield)), then answers with an **approval object**:

| Member | Req. | Description |
| --- | --- | --- |
| `approval_id` | Yes | Identifies this request for approval. Characters as in [spec 8.2](https://personalagentprotocol.org/docs/1.0/spec#conversation-requests). |
| `state` | Yes | `requested`: the account holder has been asked and hasn't answered. `approved`: they approved, and the Company is performing the action or has performed it. `declined`: they declined. `expired`: they didn't answer in time. |
| `summary` | Yes | What the account holder is asked to approve, in plain language, the way they will see it. No links (Operations 3's formatting rule applies). |
| `terms` | Yes | The terms as the account holder sees them: 1 to 12 rows of `{ "label", "value" }`, label at most 40 characters, value at most 80. Every term that affects the action MUST be a row, including any total. |
| `expires_at` | Yes | When the request for approval ends ([RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)). |
| `retry_after` | With `requested` | Seconds the Personal Agent waits before repeating the request. |
| `operation_hash` | Yes | The [shared operation hash](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/71) of this request, base64url: RFC 8785 over `operation_id` (the `approval_id`), `revision`, `summary`, `terms` (as `{ "rows": [...] }`) and `expires_at` (UTC, `Z`, whole seconds), then SHA-256. The signed answer is bound to it, so the Company, the Personal Agent and another verifier can name the same request the same way. |

**APIs.** HTTP 403, with a `Retry-After` header when the state is `requested`, and a JSON body:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
Retry-After: 5

{
  "error": "account_holder_approval_required",
  "error_description": "The account holder has been asked to approve this in the BotShield app.",
  "approval": {
    "approval_id": "apv_8Hq2Lk",
    "state": "requested",
    "summary": "Change your plan to **Unlimited Plus**, from your next bill.",
    "terms": [
      { "label": "Plan", "value": "Unlimited Plus" },
      { "label": "Starts", "value": "Next bill, Dec 1" },
      { "label": "Total", "value": "$95.00 a month" }
    ],
    "expires_at": "2026-11-18T17:05:00Z",
    "retry_after": 5,
    "operation_hash": "Kj7dqgUHbHjCPWlB9vAxrIyNJG595fhuE_YifMSpe_I"
  }
}
```

**MCP.** The tool returns an error result (`isError: true`), with the approval object in
`structuredContent.approval`, and text that works for any MCP client, including one that doesn't
support this extension:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Not done yet. The account holder needs to approve this in the BotShield app on their phone: change your plan to Unlimited Plus ($95.00 a month). Call this tool again after they approve." }],
  "structuredContent": { "approval": { "approval_id": "apv_8Hq2Lk", "state": "requested", "summary": "Change your plan to **Unlimited Plus**, from your next bill.", "terms": [{ "label": "Plan", "value": "Unlimited Plus" }, { "label": "Total", "value": "$95.00 a month" }], "expires_at": "2026-11-18T17:05:00Z", "retry_after": 5, "operation_hash": "29gnTv_ZQpd-Q5RTt9C1o_clGWFrn0Fg3xIblKXQ5EQ" } }
}
```

**Conversations.** The Company Agent's message carries the approval object in
`extensions["botshield.ai/approval"].approval`, and says in its `text` that the account holder has
been asked. When the state changes, a later message carries the object again with the new state.
The JSON Schema is [`schemas/approval-content.schema.json`](../../schemas/approval-content.schema.json).

## 6. What the Personal Agent does

On an approval object with `state` `requested`, the Personal Agent:

1. MUST NOT treat the action as done.
2. MUST NOT ask the User to approve it in its own interface, and MUST NOT tell the Company it
   approved, in any header, message or tool argument. Nothing it sends counts as approval.
3. Tells the User, in its own words, that the Company has asked the account holder to approve this
   in the BotShield app, and shows the Company's `organization.name` with the `summary` or `terms`.
   They are content from the Company ([spec 10.1](https://personalagentprotocol.org/docs/1.0/spec#untrusted-content)).
4. Repeats the same request, no sooner than `retry_after` seconds later, with the same method,
   target URI and content, and the header `BotShield-Approval-Id` set to the `approval_id`. In MCP it
   calls the same tool with the same arguments and puts the `approval_id` in the call's `_meta`
   under `botshield.ai/approval-id`. In a conversation it waits for the Company's next message.
5. Stops repeating when the state is `declined` or `expired`, when `expires_at` passes, or when the
   User withdraws the request. It tells the User the action wasn't performed.

A Personal Agent that doesn't support the extension sees an ordinary error, and its User reads the
`error_description` or the MCP text. That keeps the action safe for every client: nothing happens
without the account holder.

## 7. What the Company does with a repeated request

The Company finds the request for approval by `approval_id`, or by what the request means, within
the same account. Then:

| The account holder… | The Company |
| --- | --- |
| hasn't answered | answers with the same approval object, `state` `requested` |
| approved | checks the signed answer ([section 9](#9-the-company-and-botshield)), performs the action, and responds as it would without this extension |
| declined | performs nothing, answers with `state` `declined` |
| didn't answer in time | performs nothing, answers with `state` `expired` |

- The request MUST ask for exactly what was approved: the same action, with the same terms. If it
  asks for anything else, the Company starts a new request for approval with a new `approval_id`.
  The Company compares what the requests mean, not their bytes.
- The Company performs each approved action **at most once**. A repeated request after it was
  performed gets the first response, at least until `expires_at`. While the outcome is unknown, it
  answers with HTTP 503 and `Retry-After`, never as a failure.
- An approval belongs to the account. A repeated request in another Session of the same Personal
  Agent and account can use it. A request from another account or another Personal Agent can't.
- `declined` and `expired` say nothing the Session couldn't already see: no reason, no detail about
  the person.

## 8. The signed answer

When the account holder approves, BotShield issues the Company a token: a JWT signed with ES256,
from issuer `https://api.botshield.ai`, verifiable against
`https://api.botshield.ai/.well-known/jwks.json`. It carries:

| Claim | Meaning |
| --- | --- |
| `aud` | The Company's BotShield organization. A token for another Company fails. |
| `request_id` | The Company's own ID for the request for approval. |
| `act` | The Company's action key, then `:`, then the request's `operation_hash`. |
| `verified` | `true` |
| `iat`, `exp` | Issued at, and a short expiry. |

It carries no name, email, phone number, BotShield user ID or account reference. It is good once:
the Company checks it with BotShield, which refuses it a second time. The account holder's passkey
signs the terms rows that were shown, and BotShield keeps that record.

## 9. The Company and BotShield

This section is the Company's side, and is not visible to the Personal Agent. The
[`@botshield/poppy`](../../packages/poppy) package does it for Node.js.

1. **Start.** The Company's server calls BotShield's Actions API with its secret key: its own
   reference for the account, the action, the terms rows, a time limit, and a `request_id` it
   chooses. The action string ends with the request's `operation_hash`, so the signed answer is
   bound to it.
2. **Wait.** It reads where the request stands, with the same key, until it is approved, declined
   or expired.
3. **Check.** It checks the token once with BotShield, with its secret key and the `request_id` it
   expects, and checks that `act` is the one it sent.
4. **Perform.** Only then does it perform the action, once.

If the account isn't linked to BotShield, BotShield refuses step 1 and nothing reaches anyone. The
Company then handles the action as section 3 says.

## 9a. Approving an assistant: the purchase gate

Some Companies want something broader than one action: **this account holder's assistant may buy
here**, approved once, and checked at every checkout. The same extension and the same response
carry it. Only what the account holder approves changes.

1. **Asking the account holder.** When the Company chooses to ask, it reads the assistant's
   `client_name` from its Poppy metadata (the document at its `client_id`, spec 4.1) and asks the
   account holder through BotShield: *"Let {client_name} buy for you"*, with rows naming the
   assistant and its host. It answers the Personal Agent with the usual
   `account_holder_approval_required` and approval object. The Company decides when to ask: at the
   first checkout from an assistant it hasn't seen, or only when its own checks say so. A Company
   that doesn't ask treats an assistant that isn't approved as no match (step 3) and answers the
   Personal Agent with its usual decline.
2. **On approval.** BotShield reads the assistant's metadata itself and confirms the name the person
   approved is its `client_name`. The Company then holds **BotShield's pairwise ID** for this
   approval: one Company, one account, one assistant (`client_id`) and, under Poppy, that
   assistant's User ID (`sub`). The ID is never sent to the Personal Agent.
3. **Every checkout.** The Company verifies the Poppy Session (spec 5.3) and asks BotShield,
   fresh, with the account, the pairwise ID, the assistant's `client_id` and `sub`, and its own
   reference for the order. BotShield answers `match` with a time and a check ID, or no match, with
   no reason. An answer is for that order only.
4. **Removing it.** The person sees each approved assistant under the Company in the BotShield app
   and can remove it. Every check after that is no match. On a no match the Company decides, as in
   step 1: it declines, uses its own checks, or asks the account holder again.

A match says this is the account holder's assistant. It isn't consent to a purchase's terms: for an
action where the Company wants that, it asks for the action itself (section 5). BotShield records each
check (Company, time, result), never what was bought.

## 10. Security considerations

- **The Personal Agent can't approve.** No header, tool argument or message from the Personal Agent
  is approval. Only the signed answer is, and it comes from BotShield to the Company's server.
- **The account holder, on their own device.** The request reaches the person who linked this
  account to BotShield, on a phone that holds their passkey. It doesn't show that they understood
  the terms or weren't under pressure; it shows the holder of that passkey approved these terms.
- **What the Personal Agent learns.** That the account holder was asked, and how it ended. Nothing
  about who they are.
- **What BotShield learns.** That this Company asked this person to approve these terms, and the
  answer. BotShield doesn't learn which Personal Agent asked, or the User's ID at the Personal
  Agent.
- **Forged state.** The approval object comes from the Company. A Personal Agent that believes a
  false `requested` only waits. A false `approved` performs nothing on its own: the Company still
  needs the signed answer.
- **Replay.** The signed answer is single use, short lived, and bound to one Company, one
  `request_id` and one set of terms.
- **Request flooding.** The Company decides when to ask. BotShield limits how many requests one
  Company can have waiting for one person, and how many it sends in a day.

## 11. References

- [Personal Agent Protocol 1.0](https://personalagentprotocol.org/docs/1.0/spec), sections 3.3, 3.4, 7, 8.4, 10.1
- [Operations extension, version 3](https://personalagentprotocol.org/docs/1.0/extensions/operations), sections 3, 7 and 8.1
- [RFC 7519 JWT](https://www.rfc-editor.org/rfc/rfc7519), [RFC 7518 ES256](https://www.rfc-editor.org/rfc/rfc7518)
- [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) (passkeys)
