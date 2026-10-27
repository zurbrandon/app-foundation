# Deploying into an app's project

The foundation installs **into each app's own Supabase project**. There is no
shared service and no shared database. These are the steps in order, with the
two that are easy to miss called out.

```bash
supabase link --project-ref <ref>   # asks for the database password
supabase db push                    # applies supabase/migrations/
supabase config push                # applies supabase/config.toml  ← easy to miss
supabase secrets set OPENAI_API_KEY=sk-...
supabase functions deploy ai-gateway
```

## `db push` does not push config

`db push` applies migrations. It does **not** apply `config.toml`. The
`foundation` schema lives in that file:

```toml
[api]
schemas = ["public", "graphql_public", "foundation"]
```

Without `config push`, every migration lands, every table exists, the function
deploys cleanly — and the gateway fails at runtime on its first RPC with:

```
PGRST106  Invalid schema: foundation
```

because `Ledger` reaches the SQL functions through PostgREST
(`db.schema('foundation').rpc(...)`), and PostgREST only serves schemas it has
been told to expose. A successful build and a successful deploy both prove
nothing about this.

## Exposing `foundation` does not weaken it

Exposure and permission are separate. `0001` revokes everything on the
`foundation` schema from `anon` and `authenticated`, so once it is exposed the
grants — not the schema list — are what hold the line. Verified against the
live project with both an anon key and a signed-in user's JWT:

| Attempt | Result |
| --- | --- |
| anon calls `grant_credits` | `42501 permission denied for schema foundation` |
| signed-in user calls `grant_credits` | `42501` |
| signed-in user `PATCH`es `credit_balances` | `42501` |
| signed-in user inserts into `credit_entries` | `42501` |
| signed-in user reads another user's balance | `200 []` (RLS) |
| signed-in user calls `settle_reservation` | `42501` |
| signed-in user reads `ai_usage` | `42501` |
| gateway call with an empty balance | `402 insufficient_credits` |

## `config push` can downgrade a live project

`config.toml` is generated from the CLI's local-development defaults, which are
deliberately permissive. Pushed unread, they will turn off email confirmation,
shorten OTPs and drop the resend interval to a second. Diff before pushing —
`supabase link` prints it, and answering `n` to every prompt of a
`config push` prints it without applying anything:

```bash
yes n | supabase config push
```

Align the *local* file up to the project's safer values rather than pushing the
defaults down.

## Verifying a deployment

A build that succeeds has verified nothing about money. Grant a few credits to
a throwaway user, make one real call, and read the ledger back:

- `credit_entries` holds a `+n grant` and a `-n spend`, and nothing else
- the matching `credit_reservations` row is `settled`, with the free/paid split
- `ai_usage` has one `ok` row with real token counts and no prompt text
- replaying the grant's idempotency key leaves the balance unchanged
