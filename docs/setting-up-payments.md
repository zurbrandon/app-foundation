# Setting up payments

Everything between "the backend is ready" and "someone can buy credits". The
backend half is done and tested; all of this is account setup and app code.

Five phases, each a gate on the next. **Phase 1 is the slow one** — Apple's
agreement can take a day or two to go active, and nothing else can start until
it does. Do that first even if you do nothing else this week.

Where things stand: the ledger, webhook and secret are live on the Wearwell
project. `wearwell.credits_1000` exists as a product. Sandbox purchases are
currently **not** credited, which is deliberate and explained in Phase 4.

---

## Phase 1 — Apple's paperwork

Nothing else works until this is active, and it is the only step with a waiting
period.

0. **First, accept the current Apple Developer Program License Agreement**, or
   the Paid Apps row will not appear at all. If App Store Connect shows a
   banner saying the DPLA has been updated, the Account Holder must accept it
   at `developer.apple.com/account`. Until then it also blocks app updates and
   new submissions, so this bites the next build too, not just payments.
1. Go to **App Store Connect → Business** (`appstoreconnect.apple.com/business`
   works, though Apple documents no deep link — navigate via **Business** in
   the top nav if it does not).
2. On the **Agreements** tab, find **Paid Apps** → **View and Agree to Terms**.
3. Fill in **Bank Account** and **Tax Forms**. You will need routing and account
   numbers and a tax ID.
4. Wait for the agreement to show **Active**. Hours to a couple of days.

> You cannot create in-app purchase products — not even for sandbox testing —
> until this agreement is active. If you are not prepared to hand Apple banking
> details, stop here: there is no way to sell digital credits on iOS without it.

---

## Phase 2 — The product in App Store Connect

2. **App Store Connect → Wearwell → Monetization → In-App Purchases → +**
3. Choose **Consumable**. Credits are used up, so they are not non-consumable
   and not a subscription.
4. **Reference Name**: `1000 Credits`. Internal only.
5. **Product ID**: `wearwell.credits_1000`

   > This string must match `foundation.products.product_id` exactly. It is the
   > only link between what Apple charges for and what the ledger grants. A typo
   > here surfaces as `rejected: unknown product` in `purchase_events` after a
   > real payment has already been taken.

6. Set a price. Apple picks the tier per region; you choose the band.
7. Add a **localized display name** and **description** — Apple requires these
   before the product leaves "Missing Metadata".
8. Add a **review screenshot** of the purchase screen. You can do this later,
   but the product stays unsubmittable without it.

**Pricing sanity check.** 1000 credits is about 330 garment tags, roughly 90c
of provider spend at current prices. Anything at or above $1.99 is comfortably
profitable after Apple's cut; below about $1.49 is not, once the 15% Small
Business Program rate is applied.

---

## Phase 3 — RevenueCat

3. Create an account at `app.revenuecat.com` and a **Project**.
4. **Add an app** → Apple App Store. Bundle ID: `com.brandonarnold.wearwell`.
5. Give RevenueCat an **App Store Connect API key** (In-App Purchase key), so it
   can verify receipts. App Store Connect → Users and Access → Integrations →
   In-App Purchase → generate, download the `.p8`, upload it to RevenueCat. The
   `.p8` downloads **once** — keep it somewhere you can find it.
6. **Products** → **+ New** → import `wearwell.credits_1000` from the App Store.
7. **Offerings** → create one with a package containing that product. The app
   asks RevenueCat for the current offering rather than hardcoding a product id,
   which is how you change what is on sale without shipping a build.

### The webhook

8. **Integrations → Webhooks → Add new configuration**.
9. **URL**: `https://snjtutnadjrnjekfcuft.supabase.co/functions/v1/payments-webhook`
10. **Authorization header**: the value of `PAYMENTS_WEBHOOK_SECRET` in
    `.env.local` in this repo. Paste it **exactly as stored**.

    > The endpoint accepts it with or without a `Bearer ` prefix, because
    > RevenueCat's docs do not say which it sends. Either works.

11. **Environment**: enable **both** sandbox and production. You want sandbox
    events arriving so Phase 4 can verify the wiring; they will be recorded and
    refused rather than credited, which is the point.

RevenueCat retries a non-2xx five times over about 80 minutes, then gives up.
The endpoint answers 200 for everything legitimate — including duplicates and
events it does not handle — so a retry storm means something is genuinely
wrong, not merely unusual.

---

## Phase 4 — Wiring the app

This is the only part that is code, and two details matter more than the rest.

### Tell RevenueCat who the user is

```ts
await Purchases.configure({ apiKey: REVENUECAT_PUBLIC_KEY });
await Purchases.logIn(supabaseUserId);   // not optional
```

`app_user_id` on the webhook event is whatever this was set to. If it is not
the Supabase user id, the webhook cannot match the payment to an account and
records `rejected: unknown user` — **after the money has been taken**. This one
line is the whole integration.

### Do not sell to an anonymous account

```ts
if (await foundation.isAnonymous()) {
  // Secure the account first — Sign in with Apple is one tap.
  return promptToSecureAccount();
}
```

An anonymous user cannot sign back in after reinstalling, so credits bought
against one leave with the install while the refund request stays. Conversion
keeps the same user id and both credit buckets — verified against the deployed
project — so securing first costs them nothing.

The webhook will credit an anonymous account anyway, because by the time it
fires the money has moved and refusing would mean taking payment and giving
nothing. It logs loudly and marks the row. **That log firing means this check
is missing.**

### Testing it

1. App Store Connect → **Users and Access → Sandbox → Test Accounts** → create
   one. Use an email you control that is not an existing Apple ID.
2. On a real device, sign out of the App Store, run the app, and buy.
3. Watch `foundation.purchase_events`. You should see the event arrive with
   `environment = 'sandbox'` and `status = 'rejected'`.
4. To make sandbox purchases actually credit while you test:

   ```sql
   update foundation.settings set value = 'true'::jsonb
    where key = 'credit_sandbox_purchases';
   ```

> ### ⚠️ Turn that back off before anyone else has the build
>
> **TestFlight purchases are sandbox purchases.** With this on, any tester can
> buy the same pack repeatedly — Apple charges them nothing — and receive real
> credits every time. That is not a determined attacker; it is what happens
> when you hand a build to someone and ask them to try the purchase flow.
>
> ```sql
> update foundation.settings set value = 'false'::jsonb
>  where key = 'credit_sandbox_purchases';
> ```

---

## Phase 5 — Before release

- [ ] `credit_sandbox_purchases` is `false`
- [ ] `welcome_credits` is sized for a paywall, not for onboarding — count the
      *tags* you want to give away and multiply by the operation's
      `credits_flat`
- [ ] `welcome_daily_cap` still makes sense at that grant size
- [ ] The purchase sheet refuses anonymous accounts
- [ ] A production purchase has been seen to credit, end to end
- [ ] App Privacy declares what the AI features send

```sql
select key, value from foundation.settings order by key;
select environment, status, count(*) from foundation.purchase_events
 group by 1, 2 order by 1, 2;
```

---

## When it goes wrong

Everything the provider claimed is in `foundation.purchase_events`, including
events that produced no ledger entry. That table is append-only — not even the
service key can modify it — so it is the record to trust in a dispute.

```sql
select received_at, environment, event_type, status, credits, shortfall, note
  from foundation.purchase_events
 order by received_at desc limit 20;
```

| `status` | What it means |
| --- | --- |
| `credited` | Worked. Credits are in the paid bucket. |
| `duplicate` | Redelivery of an event already handled. Normal. |
| `rejected` + `sandbox…` | A sandbox purchase, not credited. Expected on TestFlight. |
| `rejected` + `unknown product` | Product ID mismatch between Apple and `foundation.products`. |
| `rejected` + `unknown user` | `Purchases.logIn()` was not called with the Supabase user id. |
| `reversed` / `reversed_partial` | A refund. `shortfall` is what was already spent and could not be taken back. |

Nothing in the table at all means the request never arrived: check the
Authorization header value, and that the function is deployed with
`--no-verify-jwt` (Supabase's gateway rejects a non-`Bearer` header before the
function runs — the two are mutually exclusive, see the README).
