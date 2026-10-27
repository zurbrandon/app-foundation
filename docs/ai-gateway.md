# AI gateway

An app sends an **operation name** and never a provider or model. Everything
about how that operation is served lives in `foundation.ai_operations`, so
changing a model is an `UPDATE` — not an app release going through review.

```
POST /functions/v1/ai-gateway
Authorization: Bearer <the user's JWT>

{ "operation": "wearwell.tag_garment",
  "requestId": "<stable across retries>",
  "input": { "text": "...", "image": { "base64": "...", "mediaType": "image/jpeg" } } }
```

Returns `{ text, operation, creditsCharged, balance }`.

## Order of operations

```
resolve -> reserve -> call provider -> settle -> log
```

Credits are held **before** the provider is called. Charging afterwards would
let someone with one credit fire fifty parallel requests, all passing a balance
check before any of them deducted.

## Charge modes

| Mode | Holds | Settles at | For |
|---|---|---|---|
| `flat` | `credits_flat` | the same fixed amount | predictable work — tagging a garment |
| `metered` | `credits_estimate` | measured cost via `usd_to_credits` | variable work — transcribing an hour of audio |

**Both modes reserve.** The reservation is the concurrency guard, not a
cost-control nicety, so it isn't optional for cheap operations. A flat
operation simply settles at a fixed number regardless of tokens, which is what
keeps a balance meaning "about this many garments" rather than a meter the user
has to watch.

A metered settle is **capped at the amount held**, so a runaway generation
can't empty an account. The shortfall is visible in `ai_usage` for tuning the
estimate.

## Failure

| What happened | User charged | Logged as |
|---|---|---|
| Provider errored | nothing — hold released in full | `provider_error` |
| Provider timed out | nothing — hold released in full | `timeout` |
| Not enough credits | nothing — provider never called | `insufficient_credits` |
| Crash between reserve and settle | nothing — swept by `expire_reservations` | — |

## Adding an operation

```sql
insert into foundation.ai_operations
  (operation, provider, model, charge_mode, credits_flat,
   input_usd_per_mtok, output_usd_per_mtok, max_output_tokens)
values
  ('wearwell.tag_garment', 'openai', '<model>', 'flat', 1, 0.15, 0.60, 512);
```

Switching provider later is one statement:

```sql
update foundation.ai_operations
   set provider = 'anthropic', model = '<model>',
       input_usd_per_mtok = 1.0, output_usd_per_mtok = 5.0
 where operation = 'wearwell.tag_garment';
```

## Privacy

`ai_usage` records tokens, cost, latency and status — **never prompt or
response text**. The questions it needs to answer are what things cost and
whether they worked, and neither requires keeping what a user wrote or
photographed.

## Secrets

Provider keys are read from the Edge Function environment and never leave it:

```bash
supabase secrets set OPENAI_API_KEY=sk-...
```

The function uses two clients — one built from the caller's JWT purely to
establish *who is asking*, and a `service_role` client for the ledger.
Resolving identity from the token rather than the request body is what stops
one user spending another's credits.
