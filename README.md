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
docs/                  http-api.md (the contract), ai-gateway.md, deploying.md
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

> ### ⚠️ Turn this down before any public App Store release
>
> **`welcome_credits` is temporarily 500 on the Wearwell project** (2026-10-29),
> so one person can tag a whole existing wardrobe in one sitting. That is an
> onboarding allowance for a known user, not a public default — it is 166 tags,
> roughly 46c of provider spend per stranger who installs the app.
>
> Before submitting to the App Store, set it to a number that reaches a paywall:
>
> | Credits | Tags | Cost each |
> | --- | --- | --- |
> | **15** | **5** | **$0.014** ← "four or five goes, then the paywall" |
> | 50 | 16 | $0.044 |
>
> Note those are not the same thing: 50 credits buys 16 tags, not 4–5. Pick by
> the number of *tags* you want someone to get, then multiply by the operation's
> `credits_flat` (currently 3).
>
> ```sql
> update foundation.settings set value = '15'::jsonb where key = 'welcome_credits';
> ```
>
> Also revisit `welcome_daily_cap` at that point. At 500 a head it allows ten new
> users a day before closing; at 15 a head it allows over three hundred.

The split exists because one number cannot do both jobs it gets asked to do.
Enough to try the thing is not enough to finish onboarding a 150-piece
wardrobe, and sizing it for the latter hands every passer-by half a dollar of
provider spend. So the grant is a trial, and anyone who needs more is topped up
deliberately.

**The cap is the part that bounds the risk.** Anonymous sign-in is open by
design, and Supabase still allows 30 per hour per IP by default. Without a
ceiling the free programme is an unbounded liability; with one the worst case
is a number chosen in advance. It reads the ledger rather than a counter, so it
cannot drift from what was actually given away, and it counts only welcome
grants — purchases and manual top-ups do not eat the allowance.

Two deliberate choices worth keeping:

1. **A failed grant never blocks sign-in.** The trigger shares a transaction
   with the account insert, so an error that propagated would mean nobody can
   sign in at all. It traps and warns instead, trading "no free credits, top
   them up later" for nothing worse.
2. **Running dry is not an error.** Past the cap an account is still created,
   it simply starts at zero, and the gateway already refuses with
   `insufficient_credits`.

Onboarding someone with a large existing library will exhaust a trial. Either
raise `welcome_credits` for the day, or grant them directly:

```sql
select foundation.grant_credits(
  '<user id>', 500, 'free', 'grant', 'topup:<something unique>', 'manual top-up');
```

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
