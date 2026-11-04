// App Foundation — turning verified payments into credits.
//
// Run against a local Supabase Postgres (`npm run db:start`), never a deployed
// project.
//
// Payment webhooks are retried. RevenueCat and Stripe both resend on any
// non-2xx, and sometimes on success too, so "the same event arrives twice" is
// the normal case rather than the edge case — and getting it wrong means
// either giving away credits or taking money for nothing. Most of this file is
// about that, and about refunds, which cannot always take back what they gave.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';

let sql;

const USER = 'dddddddd-0000-0000-0000-000000000001';
const OTHER = 'dddddddd-0000-0000-0000-000000000002';
const SMALL = 'test.credits_small';
const LARGE = 'test.credits_large';
const GONE = 'test.credits_retired';

async function makeUser(id, { anonymous = false } = {}) {
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, is_anonymous, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${anonymous ? null : `p${id.replace(/-/g, '')}@example.com`}, ${anonymous}, now(), now())`;
}

const purchase = async (eventId, { user = USER, product = SMALL, type = 'INITIAL_PURCHASE', sandbox = false } = {}) =>
  (await sql`select foundation.record_purchase('test', ${eventId}, ${type}, ${user}, ${product}, null, ${sandbox}) as v`)[0].v;

const refund = async (eventId, { user = USER, product = SMALL, type = 'CANCELLATION', sandbox = false } = {}) =>
  (await sql`select foundation.record_refund('test', ${eventId}, ${type}, ${user}, ${product}, null, ${sandbox}) as v`)[0].v;

const setting = (key, value) =>
  sql`insert into foundation.settings (key, value) values (${key}, ${value}::text::jsonb)
      on conflict (key) do update set value = excluded.value`;

const balanceOf = async (id) => {
  const [row] = await sql`select free, paid from public.credit_balances where user_id = ${id}`;
  return row ? { free: Number(row.free), paid: Number(row.paid) } : null;
};

const eventRow = async (eventId) => {
  const [row] = await sql`
    select status, credits, shortfall, note, environment from foundation.purchase_events
     where provider = 'test' and event_id = ${eventId}`;
  return row;
};

/** Spend paid credits the way a settled operation would. */
const spendPaid = (user, amount) =>
  sql`select foundation.debit_credits(${user}, ${amount}, 'paid'::foundation.credit_bucket,
        'spend'::foundation.credit_kind, ${'spend-' + Math.random()}, 'test spend')`;

let previousWelcome;

before(async () => {
  sql = postgres(URL, { max: 6, onnotice: () => {} });

  // Creating an account now fires the welcome grant, which would put credits
  // in `free` and make every assertion here depend on a setting that has
  // nothing to do with purchases. Switch it off for this file and restore it.
  [{ value: previousWelcome }] = await sql`
    select value from foundation.settings where key = 'welcome_credits'`;
  await sql`update foundation.settings set value = '0'::jsonb where key = 'welcome_credits'`;
  await sql`
    insert into foundation.products (product_id, credits, description, enabled) values
      (${SMALL}, 500, 'small pack', true),
      (${LARGE}, 5000, 'large pack', true),
      (${GONE}, 100, 'retired pack', false)
    on conflict (product_id) do update set credits = excluded.credits, enabled = excluded.enabled`;
});

after(async () => {
  await sql`update foundation.settings set value = ${sql.json(previousWelcome)}
             where key = 'welcome_credits'`;
  await sql`delete from auth.users where id::text like 'dddddddd-%'`;
  await sql`delete from foundation.products where product_id like 'test.%'`;
  await sql.end();
});

beforeEach(async () => {
  await sql`delete from foundation.purchase_events where provider = 'test'`;
  await sql`delete from auth.users where id::text like 'dddddddd-%'`;
  await makeUser(USER);
  await makeUser(OTHER);
});

describe('crediting a purchase', () => {
  it('credits the paid bucket, never the free one', async () => {
    // The buckets have different rules — paid credits are refundable and never
    // expire. A purchase landing in `free` would quietly lose both.
    await purchase('evt-1');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 500 });

    const [entry] = await sql`
      select kind, bucket, delta, ref_type, ref_id from public.credit_entries
       where user_id = ${USER}`;
    assert.equal(entry.kind, 'purchase');
    assert.equal(entry.bucket, 'paid');
    assert.equal(Number(entry.delta), 500);
    assert.equal(entry.ref_type, 'test');
    assert.equal(entry.ref_id, 'evt-1');
  });

  it('takes the amount from the product, not from the caller', async () => {
    // A client naming an amount could name any amount. It names a product.
    await purchase('evt-2', { product: LARGE });
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 5000 });
  });

  it('absorbs a replayed webhook', async () => {
    const first = await purchase('evt-3');
    const second = await purchase('evt-3');

    assert.equal(first.applied, true, 'the first call credits');
    assert.equal(second.applied, false, 'the replay reports it was already handled');
    assert.equal(second.status, 'duplicate', 'and says why, rather than looking like a refusal');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 500 }, 'credited exactly once');
  });

  it('absorbs a replay even under concurrent delivery', async () => {
    // Providers can deliver the same event twice at once. Only one may win.
    const results = await Promise.all(Array.from({ length: 8 }, () => purchase('evt-4')));
    const applied = results.filter((r) => r.applied).length;

    assert.equal(applied, 1, 'exactly one delivery credited the account');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 500 });
  });

  it('keeps separate events separate', async () => {
    await purchase('evt-5a');
    await purchase('evt-5b');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 1000 }, 'two genuine purchases');
  });

  it('refuses a product it does not sell, and records why', async () => {
    // Refusals return rather than raise: an exception would roll back the row
    // recording the refusal, so the audit trail would be empty exactly when it
    // mattered. It also lets the webhook answer 200 — retrying will not make
    // an unknown product known.
    const v = await purchase('evt-6', { product: 'test.not_a_product' });
    assert.equal(v.applied, false);
    assert.equal(v.status, 'rejected');
    assert.equal(await balanceOf(USER), null, 'nothing credited');

    const row = await eventRow('evt-6');
    assert.equal(row.status, 'rejected');
    assert.match(row.note, /unknown product/i);
  });

  it('refuses a retired product', async () => {
    const v = await purchase('evt-7', { product: GONE });
    assert.equal(v.status, 'rejected');
    assert.match((await eventRow('evt-7')).note, /disabled/i);
  });

  it('refuses a user who does not exist', async () => {
    // The table deliberately has no foreign key on user_id: it records what a
    // provider claimed, and a claim about a user who does not exist is exactly
    // the kind of event worth keeping. A constraint would reject the insert
    // before the check that diagnoses it could run.
    const v = await purchase('evt-8', { user: 'dddddddd-0000-0000-0000-00000000dead' });
    assert.equal(v.status, 'rejected');

    const row = await eventRow('evt-8');
    assert.equal(row.status, 'rejected');
    assert.match(row.note, /unknown user/i);
  });

  it('credits an anonymous account but flags it', async () => {
    // By the time a webhook lands the money has moved, so refusing would mean
    // taking payment and giving nothing. The guard belongs in the app, which
    // must not offer a purchase to an account that cannot survive a reinstall.
    await sql`delete from auth.users where id = ${OTHER}`;
    await makeUser(OTHER, { anonymous: true });

    const v = await purchase('evt-9', { user: OTHER });
    assert.equal(v.anonymous, true, 'the verdict says so, so a caller can alert on it');
    assert.deepEqual(await balanceOf(OTHER), { free: 0, paid: 500 }, 'they still get what they paid for');
    assert.match((await eventRow('evt-9')).note, /anonymous/i);
  });
});

describe('refunds and chargebacks', () => {
  it('takes the credits back', async () => {
    await purchase('evt-10');
    await refund('evt-10r');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 0 });

    const row = await eventRow('evt-10r');
    assert.equal(row.status, 'reversed');
    assert.equal(Number(row.shortfall), 0);
  });

  it('takes back only what is left, rather than going negative', async () => {
    // The non-negative check on credit_balances is the real defence against
    // double-spend. Letting a refund breach it would trade a guarantee for a
    // corner case, so a refund of already-spent credits claws back what it can.
    await purchase('evt-11');
    await spendPaid(USER, 400);
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 100 });

    await refund('evt-11r');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 0 }, 'clamped, not negative');

    const row = await eventRow('evt-11r');
    assert.equal(row.status, 'reversed_partial');
    assert.equal(Number(row.shortfall), 400, 'the unrecoverable part is recorded');
    assert.match(row.note, /already spent/i);
  });

  it('records a full shortfall when everything was spent', async () => {
    await purchase('evt-12');
    await spendPaid(USER, 500);

    await refund('evt-12r');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 0 });

    const row = await eventRow('evt-12r');
    assert.equal(Number(row.shortfall), 500);
    assert.equal(Number(row.credits), 0, 'nothing was taken back');
  });

  it('never touches free credits to satisfy a refund', async () => {
    // Free credits were never paid for. Clawing them back to cover a refund
    // would take something the user was given, not something they bought.
    await sql`select foundation.grant_credits(${USER}, 300, 'free'::foundation.credit_bucket,
      'grant'::foundation.credit_kind, 'welcome-test', 'free allowance')`;
    await purchase('evt-13');
    await spendPaid(USER, 500);

    await refund('evt-13r');
    assert.deepEqual(await balanceOf(USER), { free: 300, paid: 0 }, 'the free grant is untouched');
  });

  it('absorbs a replayed refund', async () => {
    await purchase('evt-14');
    const first = await refund('evt-14r');
    const second = await refund('evt-14r');

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(second.status, 'duplicate');
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 0 }, 'reversed exactly once');
  });

  it('does not let a refund double-dip under concurrent delivery', async () => {
    await purchase('evt-15', { product: LARGE }); // 5000
    await Promise.all(Array.from({ length: 6 }, () => refund('evt-15r', { product: LARGE })));
    assert.deepEqual(await balanceOf(USER), { free: 0, paid: 0 });

    const entries = await sql`
      select count(*)::int as n from public.credit_entries
       where user_id = ${USER} and kind = 'refund'`;
    assert.equal(entries[0].n, 1, 'one reversal, however many deliveries');
  });

  it('leaves a complete audit trail of what the provider claimed', async () => {
    await purchase('evt-16', { product: LARGE });
    await refund('evt-16r', { product: LARGE });

    const rows = await sql`
      select event_type, status, credits from foundation.purchase_events
       where provider = 'test' and user_id = ${USER} order by received_at`;

    assert.deepEqual(
      rows.map((r) => [r.event_type, r.status, Number(r.credits)]),
      [['INITIAL_PURCHASE', 'credited', 5000], ['CANCELLATION', 'reversed', -5000]]
    );
  });
});

describe('sandbox purchases', () => {
  it('does not credit one by default', async () => {
    // TestFlight purchases are sandbox purchases. Crediting them means any
    // tester can buy the same pack repeatedly, for free, forever.
    const v = await purchase('evt-20', { sandbox: true });
    assert.equal(v.status, 'rejected');
    assert.equal(await balanceOf(USER), null, 'nothing credited');
    assert.match((await eventRow('evt-20')).note, /sandbox/i);
  });

  it('records it as sandbox either way, so the trail is honest', async () => {
    await purchase('evt-21', { sandbox: true });
    const [row] = await sql`
      select environment from foundation.purchase_events
       where provider = 'test' and event_id = 'evt-21'`;
    assert.equal(row.environment, 'sandbox');
  });

  it('credits one when the deployment has opted in', async () => {
    await setting('credit_sandbox_purchases', 'true');
    try {
      const v = await purchase('evt-22', { sandbox: true });
      assert.equal(v.status, 'credited');
      assert.deepEqual(await balanceOf(USER), { free: 0, paid: 500 });
    } finally {
      await setting('credit_sandbox_purchases', 'false');
    }
  });

  it('still credits a production purchase while sandbox is off', async () => {
    const v = await purchase('evt-23', { sandbox: false });
    assert.equal(v.status, 'credited');
    assert.equal((await eventRow('evt-23')).environment ?? 'production', 'production');
  });
});

describe('what a client is not allowed to do', () => {
  it('keeps the purchase tables away from anon and authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['foundation.products', 'foundation.purchase_events']) {
        const [{ ok }] = await sql`
          select has_table_privilege(${role}, ${table}, 'SELECT, INSERT, UPDATE, DELETE') as ok`;
        assert.equal(ok, false, `${role} must not reach ${table}`);
      }
    }
  });

  it('keeps the crediting functions to service_role', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const fn of [
        'foundation.record_purchase(text, text, text, uuid, text, jsonb, boolean)',
        'foundation.record_refund(text, text, text, uuid, text, jsonb, boolean)',
      ]) {
        const [{ ok }] = await sql`select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`;
        assert.equal(ok, false, `${role} must not execute ${fn}`);
      }
    }
  });
});
