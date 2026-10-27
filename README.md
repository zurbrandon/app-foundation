# App Foundation

Reusable backend for small consumer apps: accounts, cloud storage, sync, an AI
gateway, a credit ledger, and payments. Installed **into each app's own
Supabase project** — not run as a shared service.

Status: **credit ledger built and tested.** Nothing deployed.

## Layout

```
supabase/migrations/   versioned SQL, applied per app project
tests/                 runs against a local Postgres, never a deployed one
docs/
```

## Running the tests

Needs Docker running. The local stack uses ports `544xx` so it can sit
alongside another Supabase project on the default `543xx`.

```bash
npm install
supabase start
supabase db reset          # applies migrations
npm test
```

`SUPABASE_DB_URL` overrides the connection (default
`postgresql://postgres:postgres@127.0.0.1:54422/postgres`).

> The tests **truncate the ledger tables**. Never point them at a deployed
> project.

## Design rules

1. **The ledger is append-only.** `credit_entries` is never updated or deleted;
   corrections are compensating entries. `credit_balances` is a cache that must
   always reconcile against it — asserted in every test.
2. **Clients never write.** Mutations live in `foundation.*` SECURITY DEFINER
   functions executable only by `service_role`, so only an Edge Function can
   move credits. Tables sit in `public` with select-own RLS, and write grants
   are revoked from `anon`/`authenticated` as a second lock.
3. **The database refuses to go wrong.** A non-negative CHECK on balances is
   the real defence against double-spend — a logic bug aborts the transaction
   rather than inventing credits.
4. **Every mutation is idempotent.** A replayed webhook or retried request
   carrying the same key is absorbed, not double-applied.

Credits are integers. Free credits are spent before paid ones, and a release
returns credits to the bucket they came from so free credits never silently
become paid ones.
