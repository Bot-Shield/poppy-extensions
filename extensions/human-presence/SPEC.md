# `botshield.ai/human-presence` · version 1

**Status:** draft · **Builds on:** [Personal Agent Protocol 1.0](https://personalagentprotocol.org/docs/1.0/spec) · **License:** Apache 2.0

A Company asks for a real person to be present before it does something, and can count each person
once, without learning who they are. The person confirms on their phone, with their passkey.

## 1. The problem

A Company can limit or block agent traffic only per Personal Agent (`client_id`). A Personal Agent
can create any number of User IDs, so the Company can't tell one person using many Sessions from
many people, and can't stop one person entering a draw, claiming an offer or joining a waitlist many
times through one agent without cutting off everyone who uses it.

This extension lets the Company ask: **is a real person here, and have they already been counted?**

- The Company starts a presence check at BotShield, for one of its own gates.
- The Personal Agent shows the User a link or QR code. The person opens it on their phone and
  confirms with their passkey in the BotShield app.
- BotShield counts each person against the gate's rule, such as one pass per person per sale, and
  gives the Company a signed answer. The answer names no person.
- The Personal Agent repeats its request.

**Example.** A ticket seller opens a presale for a show: one entry per person. A fan's assistant
asks to enter. The seller answers that a person must confirm, with a link. The fan scans it with
their phone and confirms with their passkey. The assistant repeats its request and the entry is
recorded. When the same fan, through any agent, tries to enter again, BotShield's answer is that
this person has already been counted, and the seller refuses the second entry.

## 2. What it is not

- **Not identity.** The Company learns that a person was present and whether they were already
  counted at this gate. It doesn't learn who they are, and gets no identifier it could match with
  another Company.
- **Not the account holder's approval.** Anyone with BotShield can pass a presence check. When the
  Company needs the holder of the account to approve exact terms, it uses
  [`botshield.ai/approval`](../approval/SPEC.md).
- **Not a statement about the Personal Agent.** Which software is asking is `client_id`'s job.

## 3. Advertising and declaring

```json
"extensions": {
  "botshield.ai/human-presence": [{ "version": "1" }]
}
```

```http
Poppy-Extensions: "botshield.ai/human-presence";v="1"
```

Version 1 has no other fields.

## 4. Asking for a person

The Company performs nothing. It starts a presence check at BotShield
([section 8](#8-the-company-and-botshield)) and answers with a **presence object**:

| Member | Req. | Description |
| --- | --- | --- |
| `presence_id` | Yes | Identifies this presence check. Characters as in [spec 8.2](https://personalagentprotocol.org/docs/1.0/spec#conversation-requests). |
| `state` | Yes | `requested`: waiting for the person. `passed`: a person confirmed. `refused`: the gate's rule refused this person, for example because they were already counted. `expired`: nobody confirmed in time. |
| `verification_uri` | With `requested` | The link the person opens. Its host MUST be `app.botshield.ai`. |
| `qr_code_uri` | No | An image of the same link as a QR code, for a person on a computer. Its host MUST be `api.botshield.ai`. |
| `expires_at` | Yes | When the check ends ([RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)). |
| `retry_after` | With `requested` | Seconds the Personal Agent waits before repeating the request. |

**APIs.** HTTP 403, with `Retry-After` when the state is `requested`:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
Retry-After: 5

{
  "error": "human_presence_required",
  "error_description": "A person needs to confirm in the BotShield app. Open the link on your phone.",
  "presence": {
    "presence_id": "prs_4Fk9Qa",
    "state": "requested",
    "verification_uri": "https://app.botshield.ai/verify?request_id=2b1f…",
    "qr_code_uri": "https://api.botshield.ai/qr/2b1f…",
    "expires_at": "2026-11-18T17:10:00Z",
    "retry_after": 5
  }
}
```

**MCP.** An error result (`isError: true`), the presence object in `structuredContent.presence`,
and text that works for any MCP client: "Not done yet. A person needs to confirm in the BotShield
app: open https://app.botshield.ai/verify?… on your phone, then call this tool again."

**Conversations.** `extensions["botshield.ai/human-presence"].presence` on the Company Agent's
message. The JSON Schema is
[`schemas/human-presence-content.schema.json`](../../schemas/human-presence-content.schema.json).

## 5. What the Personal Agent does

On a presence object with `state` `requested`, the Personal Agent:

1. MUST NOT treat the request as done.
2. MUST check that `verification_uri`'s host is exactly `app.botshield.ai`, and `qr_code_uri`'s,
   when present, is exactly `api.botshield.ai`. If not, it MUST NOT show them, and handles the
   response as an error. Otherwise a Company could send the User to a page posing as BotShield.
3. Shows the User the link, or the QR code on a computer, with the Company's `organization.name`,
   and says a person needs to confirm in the BotShield app. It MUST NOT open the link itself, or in
   a browser it controls, and MUST NOT complete the check: only a person can.
4. Repeats the same request, no sooner than `retry_after`, with the header `BotShield-Presence-Id`
   set to the `presence_id`. In MCP, the same tool and arguments with `botshield.ai/presence-id` in
   `_meta`. In a conversation, it waits for the next message.
5. Stops on `refused` or `expired`, or when `expires_at` passes, and tells the User.

## 6. What the Company does with a repeated request

| The check… | The Company |
| --- | --- |
| is waiting | answers with the same presence object |
| passed | checks the signed answer, records the pass on the Session, and handles the request |
| was refused by the gate's rule | performs nothing, answers with `state` `refused` |
| expired | performs nothing, answers with `state` `expired` |

- A pass belongs to the Session that started it (`client_id`, `sid` and User ID), for as long as the
  Company decides. The Company MAY ask again at any time.
- A pass is good for the gate it was made for. Another gate is another check.
- `refused` says nothing about why beyond what the Session could see. The Company doesn't learn
  which other Sessions the person used.

## 7. The signed answer

A JWT signed with ES256, from `https://api.botshield.ai`, verifiable against
`https://api.botshield.ai/.well-known/jwks.json`, with `aud` the Company's BotShield organization,
`request_id` the presence check, `verified: true`, and a short expiry. It names no person. The
Company checks it once with BotShield, which refuses it a second time.

## 8. The Company and BotShield

The Company's side, not visible to the Personal Agent. [`@botshield/poppy`](../../packages/poppy)
does it for Node.js.

1. **The gate.** In the BotShield Console, the Company places a Human Gate with its rule, such as
   one pass per person, and the window it counts in.
2. **Start.** With its secret key, the Company's server opens a check for that gate and gets the
   link, the QR code and a `request_id`.
3. **Wait.** It reads the check's status with the same key.
4. **Check.** It checks the token once with BotShield, with the `request_id` it expects.

## 9. Security considerations

- **Relayed links.** A Personal Agent, or someone using one, could send the link to another person
  to confirm. A pass shows that *a* person was present, counted once at this gate, not that they
  are the User. The gate's per-person rule is what makes relaying costly: each person counts once.
- **Phishing.** The host checks in section 5 stop a Company passing off its own page as BotShield.
  BotShield shows the person the Company's name before they confirm.
- **What BotShield learns.** That a person confirmed at this Company's gate. Counting each person
  once needs that. BotShield doesn't learn which Personal Agent asked or the User's ID there, and
  gives the Company nothing it could use to match this person with another Company.
- **What the Company learns.** Pass or refusal at its own gate. No identifier.
- **Replay.** The signed answer is single use, short lived, and bound to one Company and one check.

## 10. References

- [Personal Agent Protocol 1.0](https://personalagentprotocol.org/docs/1.0/spec), sections 3.3, 3.4, 5, 7, 8.4, 10.1
- Poppy issue [#25, A verified human signal for sessions](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/25)
- [RFC 7519 JWT](https://www.rfc-editor.org/rfc/rfc7519), [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
