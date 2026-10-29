# The HTTP contract

This is the foundation's actual interface. Everything else — the TypeScript
client in `client/`, a Swift one later — is a convenience over these calls, and
nothing may require a client to work.

That constraint exists because the apps aren't all the same stack. Wearwell and
familiar are Expo; Understory is SwiftUI on macOS and iOS. A TypeScript package
would serve two of the three and be dead weight for the third, so the contract
is HTTP and the clients stay thin enough to re-derive from this page.

Three hosts, all on the app's own Supabase project:

| Purpose | Path |
| --- | --- |
| Identity | `/auth/v1/…` (GoTrue) |
| Run an operation | `/functions/v1/ai-gateway` |
| Read a balance | `/rest/v1/credit_balances` (PostgREST, RLS select-own) |

Every request carries `apikey: <anon key>`. The anon key is public and safe to
ship in an app — it grants nothing on its own. Authority comes from the user's
JWT in `Authorization: Bearer <access_token>`.

---

## 1. Identity

Apps sign in anonymously. There is no sign-up screen, and the ledger only needs
somebody to charge, not somebody's email.

```http
POST /auth/v1/signup
apikey: <anon key>
content-type: application/json

{}
```

```json
{
  "access_token": "eyJ…",
  "refresh_token": "…",
  "expires_in": 3600,
  "user": { "id": "…", "is_anonymous": true }
}
```

The access token carries an `is_anonymous` claim. Store the refresh token —
losing it means losing the account, because an anonymous user cannot sign back
in by any other means.

### Refreshing

```http
POST /auth/v1/token?grant_type=refresh_token
apikey: <anon key>

{ "refresh_token": "…" }
```

Access tokens last an hour. Refresh before expiry rather than after a 401, and
single-flight it: several calls racing to refresh will invalidate each other's
tokens.

### Becoming a real account

Verified against a deployed project: **the user id is preserved**, and both
credit buckets and the full ledger history survive. The Supabase docs describe
the conversion but never state this, and it matters — if the id changed, every
credit bought before securing an account would orphan.

Email conversion is a two-step flow and needs a real inbox:

```http
PUT /auth/v1/user          { "email": "…" }     → sends a confirmation mail
                                                 → user clicks the link
PUT /auth/v1/user          { "password": "…" }  → only allowed once verified
```

Sending both at once fails, and so does setting a password first
(`Updating password of an anonymous user without an email or phone is not
allowed`). On iOS and macOS prefer Sign in with Apple via `linkIdentity()`,
which skips the inbox entirely.

**Buying credits must require a secured account.** An anonymous user cannot
sign back in after reinstalling, so credits bought anonymously leave with the
install while the refund request stays. Check the `is_anonymous` claim before
showing a purchase sheet.

---

## 2. Running an operation

```http
POST /functions/v1/ai-gateway
apikey: <anon key>
authorization: Bearer <access_token>
content-type: application/json
```

```json
{
  "operation": "wearwell.tag_garment",
  "requestId": "<uuid, stable across retries>",
  "input": {
    "system": "optional instruction",
    "text": "optional prompt",
    "image": { "base64": "…", "mediaType": "image/jpeg" },
    "jsonSchema": { "name": "garment", "schema": { } }
  }
}
```

The app names an **operation**, never a model. Which model runs, what it costs
and what it charges all live in `foundation.ai_operations`, so switching model
or repricing is an `UPDATE` and ships to every installed app at once — no
release required. It also means a client cannot ask for an expensive model.

`requestId` is the idempotency key. It keys the credit reservation, so a
request retried after a dropped connection reuses the original hold instead of
taking a second one. **Generate it once per logical attempt and reuse it on
every retry of that attempt** — a fresh id per retry defeats the point and can
charge twice.

### Success — 200

```json
{
  "text": "{\"name\":\"Patterned Dress Shirt\",…}",
  "operation": "wearwell.tag_garment",
  "creditsCharged": 3,
  "balance": { "free": 22, "paid": 0 }
}
```

`balance` is the balance *after* the charge, so a client never has to re-read
it after a successful call.

`text` is a string. When the operation used `jsonSchema`, it is JSON the caller
parses — the gateway doesn't, because it has no opinion about an app's schema.

### Failure

Every error is `{ "error": "<code>", "message": "…" }` with these statuses:

| Status | `error` | Meaning | What a client should do |
| --- | --- | --- | --- |
| 401 | `unauthorized` | Missing or invalid JWT | Refresh, then retry once |
| 400 | `invalid_request` | Malformed body | Fix the call; don't retry |
| 400 | `unknown_operation` | Not in `ai_operations` | Don't retry |
| 403 | `operation_disabled` | Registered but switched off | Don't retry |
| 402 | `insufficient_credits` | Hold would overdraw | Offer credits; don't retry |
| 502 | `provider_error` | Upstream failed | Retry with the **same** requestId |
| 504 | `timeout` | Provider exceeded 60s | Retry with the **same** requestId |
| 500 | `internal_error` | Fault; detail is in the logs | Retry once, then give up |

Nothing is charged unless the provider produced a result. On a provider error
or timeout the hold is released before the response is sent, so a 502 and a 504
cost the user nothing. A crash between reserving and settling is caught by the
expiry sweep rather than stranding credits.

---

## 3. Reading a balance

```http
GET /rest/v1/credit_balances?user_id=eq.<id>&select=free,paid
apikey: <anon key>
authorization: Bearer <access_token>
```

```json
[{ "free": 22, "paid": 0 }]
```

An empty array means no row yet, which is a zero balance, not an error. RLS
restricts this to the caller's own row — asking for somebody else's returns
`[]` rather than a 403, which is worth knowing when reading the response.

Only needed on launch, or after a purchase. Successful operations return the
new balance already.

Credits are integers. Free credits are spent before paid ones. A release
returns them to the bucket they came from, so free credits never silently
become paid ones.

---

## What a client must not do

- **Never hold a provider API key.** That is the entire reason this exists:
  familiar currently ships its OpenAI key inside the JS bundle via
  `EXPO_PUBLIC_`, where anyone with the `.ipa` can read it.
- **Never name a model.** Operations are the unit. See above.
- **Never write to the ledger.** `anon` and `authenticated` have no write
  grants on any ledger table and no `USAGE` on the `foundation` schema; the
  SQL functions are `service_role` only. A client that tries gets
  `42501 permission denied`, by design and verified against the live project.
- **Never send a fresh `requestId` when retrying.** It is the only thing
  standing between a dropped connection and a double charge.
