# App Foundation

Reusable backend for small consumer apps: accounts, cloud storage, sync, an AI
gateway, a credit ledger, and payments. Installed **into each app's own
Supabase project** — not run as a shared service.

Status: **ledger and AI gateway built, tested, and deployed** to the first
app's project (Wearwell). A real metered call has moved credits end to end;
eight adversarial probes against the live project were all blocked.
See [docs/deploying.md](docs/deploying.md).

## Layout

```
supabase/migrations/   versioned SQL, applied per app project
supabase/functions/    Edge Functions; _shared/ is runtime-agnostic on purpose
client/                the TypeScript client, and its tests
tests/                 runs against a local Postgres, never a deployed one
docs/                  http-api.md (the contract), ai-gateway.md,
                       deploying.md, setting-up-payments.md
```

## The contract is HTTP

[docs/http-api.md](docs/http-api.md) is the interface. `client/` is a
convenience over it, and **nothing may require a client to work**.

That is not purity — the apps aren't one stack. Wearwell and familiar are Expo;
Understory is SwiftUI on macOS and iOS. A TypeScript package would serve two of
three and be dead weight for the third, so the contract is HTTP and the client
stays thin enough to re-derive from the doc and port to Swift.

`client/foundation.ts` is dependency-free and plain `fetch`: four endpoints
don't justify ~100KB of supabase-js in a phone app, and the absence of a
framework is what makes it readable as a reference implementation.

```ts
const foundation = createFoundation({ url, anonKey, storage });

const tags = await foundation.runJson<Garment>('wearwell.tag_garment', {
  image: { base64, mediaType: 'image/jpeg' },
  jsonSchema: GARMENT_SCHEMA,
});
```

It signs in anonymously on first use, refreshes before expiry, single-flights
both so a cold start can't create two users, retries what is safe to retry, and
**reuses its `requestId` across retries** — which is what makes a retry free
rather than a second charge.

Apps vendor it by copying for now. With three apps that is cheaper than
publishing a package, and the drift it risks is bounded by the contract doc
being the source of truth. Worth revisiting at the second app, not before.

## Running the tests

Needs Docker running. The local stack uses ports `544xx` so it can sit
alongside another Supabase project on the default `543xx`.

```bash
npm install
npm run db:start
npm test
```

`npm test` covers the ledger, the gateway and the client. The client's
integration test against a deployed project is skipped unless you give it
keys:

```bash
FOUNDATION_URL=https://<ref>.supabase.co \
FOUNDATION_ANON_KEY=... FOUNDATION_SERVICE_KEY=... npm run test:live
```

That one creates a throwaway anonymous user, spends real credits on a real
provider call, and deletes the user afterwards.

`db:start` excludes storage and the rest because nothing here uses them, and
on an older CLI the storage container fails its own migrations (`Migration
revoke-grants-to-unused-operations not found`) and takes the whole stack down
with it. Don't fix that by setting `enabled = false` under `[storage]` in
`config.toml` — `supabase config push` would carry that to the deployed project
and turn storage off there too.

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

## Free credits for new users

A trigger on `auth.users` grants a new account its welcome credits, so there
is nothing for a client to call, skip, or replay. Two settings, both tunable
with an `UPDATE` against `foundation.settings` — no deploy, effective for the
next person who signs up:

| Setting | Default | Meaning |
| --- | --- | --- |
| `welcome_credits` | 100 | Per account. 33 garment tags at the current rate. |
| `welcome_daily_cap` | 5000 | Welcome credits issued in any 24 hours. 0 disables the ceiling. |

> **Sizing it.** Go by the number of *tags* you want someone to get, then
> multiply by the operation's `credits_flat` (currently 3). Credits and uses
> are not the same unit, and conflating them is how you end up giving away
> three times what you meant to.
>
> | Credits | Tags | Cost each |
> | --- | --- | --- |
> | **15** | **5** | **$0.014** ← the current value: a few goes, then the paywall |
> | 50 | 16 | $0.044 |
> | 500 | 166 | $0.456 ← a whole wardrobe; an onboarding allowance, not a default |
>
> ```sql
> update foundation.settings set value = '15'::jsonb where key = 'welcome_credits';
> ```
>
> Revisit `welcome_daily_cap` alongside it: at 15 a head the same $5 ceiling
> covers over three hundred new users a day, at 500 a head only ten.

## Buying credits

A verified payment arrives at `/functions/v1/payments-webhook`, which turns it
into ledger entries. Provider-agnostic: familiar on iOS must use Apple IAP for
digital credits, Understory on macOS outside the Mac App Store would use
Stripe, and both land in the same two SQL functions. Only `parseRevenueCat` is
provider-specific.

A client names a **product**, never an amount — the same rule as naming an
operation rather than a model. `foundation.products` maps product to credits;
what it *costs* lives in App Store Connect, because the store owns the money,
the currency and the regional pricing.

**Setup.** The webhook needs a shared secret, which is the only thing between
it and anyone who finds the URL — there is no user JWT here, the caller is a
provider:

```bash
SECRET="whsec_$(openssl rand -hex 32)"
echo "PAYMENTS_WEBHOOK_SECRET=$SECRET" >> .env.local     # gitignored
supabase secrets set PAYMENTS_WEBHOOK_SECRET="$SECRET" --project-ref <ref>
```

Then configure that same value as the provider's `Authorization` header. A
`Bearer ` prefix is tolerated, since RevenueCat's docs do not say whether it
sends the value verbatim.

The full account setup — Apple's agreement, the product, RevenueCat, and
wiring the app — is in [docs/setting-up-payments.md](docs/setting-up-payments.md).

**Deploy it with `--no-verify-jwt`:**

```bash
supabase functions deploy payments-webhook --no-verify-jwt --project-ref <ref>
```

> ### The gateway and a webhook secret are mutually exclusive
>
> This is not a layered defence you can have both halves of, and it is worth
> writing down because it looks like one. Supabase's gateway demands
> `Authorization: Bearer <valid JWT>` and rejects anything else — including a
> raw `whsec_…` value — *before the function runs*. A payment provider sends
> its own secret and cannot produce a Supabase JWT. So either the gateway
> guards the endpoint and no provider can reach it, or the function guards
> itself.
>
> Deployed without the flag, a genuine purchase returns
> `401 UNAUTHORIZED_INVALID_JWT_FORMAT` and credits nothing. Verified both
> ways, after getting it wrong in both directions first.
>
> The secret is the right guard of the two. The alternative is handing the
> provider the anon key, which would put a public credential in front of the
> endpoint that mints credits.

The function refuses every request with a 503 when the secret is unset. An
endpoint that mints credits must never be open because an environment variable
was forgotten.

**Everything legitimate answers 200.** A duplicate is not an error, an unknown
product will not become known by retrying, and an event type we do not handle
is none of our business — any other reply asks the provider to redeliver
forever. Only a bad secret (401) and a fault on our side (500) are worth a
retry.

**Refunds clamp at zero.** Buy 1000, spend 700, refund: 300 comes back and the
700 is recorded as a shortfall. The non-negative constraint on balances is the
real defence against double-spend and is not worth trading for a corner case,
and repeated buy-spend-refund is a pattern worth being able to see. Free
credits are never touched to satisfy a refund — they were never paid for.

**Sandbox purchases are not credited by default.** TestFlight purchases are
sandbox purchases, so crediting them would let any tester buy the same pack
repeatedly for free. They are recorded with `environment = 'sandbox'` and
refused. Set `credit_sandbox_purchases` to true while testing the flow, and
back to false before anyone else has the build.

**An anonymous account is credited and flagged, not refused.** By the time a
webhook arrives the money has moved, so refusing means taking payment and
giving nothing. The guard belongs in the app: do not offer a purchase to an
account that cannot survive a reinstall. See below.

## Anonymous users

Apps sign people in anonymously, so there is no sign-up wall in front of a
local-feeling app. The ledger only needs somebody to charge, not somebody's
email.

Verified against a deployed project: converting an anonymous user to a real
account **keeps the same user id**, and both credit buckets and the full
ledger history survive it. The Supabase docs describe the conversion but never
say the id is preserved, and if it weren't, every credit bought before
securing an account would orphan.

Two consequences worth holding on to:

1. **Buying credits must require a secured account.** An anonymous user cannot
   sign back in after reinstalling, so credits bought anonymously are gone with
   the install — and the refund request is not. The `is_anonymous` JWT claim is
   what enforces this; it is not optional politeness.
2. **Abandoned anonymous users accumulate forever.** Supabase has no automatic
   cleanup. `foundation.purge_abandoned_anonymous()` does it, and refuses to
   touch anyone holding paid credits or anyone who secured their account.

Conversion by email needs a confirmation round-trip, and a password cannot be
set until the address is verified. Sign in with Apple via `linkIdentity()`
avoids the inbox entirely and is the better path on iOS and macOS.
