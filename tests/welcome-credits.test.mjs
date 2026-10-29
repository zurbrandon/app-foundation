// App Foundation — the free credit grant for new users.
//
// Run against a local Supabase Postgres (`npm run db:start`), never a deployed
// project.
//
// The grant fires from a trigger on auth.users, which means it runs inside the
// transaction that creates the account. That placement is the whole reason
// these tests exist: it makes the grant impossible for a client to skip or
// replay, and it makes a bug in the grant capable of stopping anyone from
// signing in at all. So the cases that matter most are the ones where the
// grant goes wrong and the account is created anyway.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';

let sql;

const setting = (key, value) =>
  sql`insert into foundation.settings (key, value) values (${key}, ${value}::text::jsonb)
      on conflict (key) do update set value = excluded.value`;

/** Create an account the way GoTrue does, and let the trigger fire. */
async function signUp(id, { anonymous = true } = {}) {
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, is_anonymous, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${anonymous ? null : `u${id.slice(0, 8)}@example.com`}, ${anonymous}, now(), now())`;
}

const balanceOf = async (id) => {
  const [row] = await sql`select free, paid from public.credit_balances where user_id = ${id}`;
  return row ? { free: Number(row.free), paid: Number(row.paid) } : null;
};

const exists = async (id) => (await sql`select 1 from auth.users where id = ${id}`).length > 0;

const uid = (n) => `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`;

/**
 * Welcome credits already handed out inside the window.
 *
 * The ceiling is deliberately global and time-based, so every other test file
 * creating a user moves this number — and `node --test` runs files in
 * parallel. Tests therefore set the cap relative to whatever has already been
 * granted, rather than assuming they have the window to themselves.
 */
const grantedSoFar = async () =>
  Number((await sql`select foundation.welcome_granted_today() as n`)[0].n);

/** A ceiling that leaves exactly `headroom` credits available right now. */
const capWithHeadroom = async (headroom) =>
  setting('welcome_daily_cap', String((await grantedSoFar()) + headroom));

before(() => { sql = postgres(URL, { max: 4, onnotice: () => {} }); });
after(async () => { await sql.end(); });

beforeEach(async () => {
  await sql`delete from auth.users where id::text like 'cccccccc-%'`;
  await setting('welcome_credits', '100');
  await setting('welcome_daily_cap', '5000');
});

describe('welcome credits', () => {
  it('gives a new account its free credits automatically', async () => {
    await signUp(uid(1));
    assert.deepEqual(await balanceOf(uid(1)), { free: 100, paid: 0 });
  });

  it('puts them in the free bucket, never the paid one', async () => {
    // Paid credits are money owed. A free grant must never look like one, or
    // the purge job would refuse to clean up abandoned users forever.
    await signUp(uid(2));
    const [entry] = await sql`
      select kind, bucket, delta, ref_type from public.credit_entries where user_id = ${uid(2)}`;
    assert.equal(entry.bucket, 'free');
    assert.equal(entry.kind, 'grant');
    assert.equal(entry.ref_type, 'welcome');
    assert.equal(Number(entry.delta), 100);
  });

  it('grants once per account, even if the trigger were to run twice', async () => {
    await signUp(uid(3));
    // The idempotency key is derived from the user id, so a replay is absorbed
    // by the ledger rather than doubling the grant.
    await sql`
      select foundation.grant_credits(${uid(3)}, 100, 'free'::foundation.credit_bucket,
        'grant'::foundation.credit_kind, ${'welcome:' + uid(3)}, 'welcome grant', 'welcome', null)`;
    assert.deepEqual(await balanceOf(uid(3)), { free: 100, paid: 0 });
  });

  it('can be switched off entirely', async () => {
    await setting('welcome_credits', '0');
    await signUp(uid(4));
    assert.equal(await balanceOf(uid(4)), null, 'no ledger row at all');
    assert.equal(await exists(uid(4)), true, 'and the account is still created');
  });

  it('is tunable without a deploy', async () => {
    await setting('welcome_credits', '250');
    await signUp(uid(5));
    assert.deepEqual(await balanceOf(uid(5)), { free: 250, paid: 0 });
  });
});

describe('the daily ceiling', () => {
  it('stops granting once the cap is reached', async () => {
    await setting('welcome_credits', '100');
    await capWithHeadroom(250);

    await signUp(uid(10));
    await signUp(uid(11));
    // 200 of the 250 used; a third would overshoot.
    await signUp(uid(12));

    assert.deepEqual(await balanceOf(uid(10)), { free: 100, paid: 0 });
    assert.deepEqual(await balanceOf(uid(11)), { free: 100, paid: 0 });
    assert.equal(await balanceOf(uid(12)), null, 'the third gets nothing');
  });

  it('still creates the account when the cap is hit', async () => {
    // Running dry must never mean nobody can sign in. They start at zero, and
    // the gateway already refuses with insufficient_credits.
    await capWithHeadroom(50);
    await signUp(uid(13));

    assert.equal(await exists(uid(13)), true);
    assert.equal(await balanceOf(uid(13)), null);
  });

  it('counts only welcome grants, not purchases or manual top-ups', async () => {
    await capWithHeadroom(250);
    const before = await grantedSoFar();
    await signUp(uid(14)); // 100 of the headroom

    // A deliberate top-up and a purchase must not eat the free allowance.
    await sql`
      select foundation.grant_credits(${uid(14)}, 5000, 'free'::foundation.credit_bucket,
        'grant'::foundation.credit_kind, ${'topup-' + uid(14)}, 'manual top-up', 'admin', null)`;
    await sql`
      select foundation.grant_credits(${uid(14)}, 5000, 'paid'::foundation.credit_bucket,
        'purchase'::foundation.credit_kind, ${'buy-' + uid(14)}, 'bought', 'revenuecat', null)`;

    assert.equal(
      (await grantedSoFar()) - before,
      100,
      'only the welcome grant counts toward the ceiling'
    );

    await signUp(uid(15));
    assert.deepEqual(await balanceOf(uid(15)), { free: 100, paid: 0 }, 'next user still served');
  });

  it('ignores welcome grants older than the window', async () => {
    await capWithHeadroom(150);
    const before = await grantedSoFar();
    await signUp(uid(16));
    assert.equal((await grantedSoFar()) - before, 100);

    // Yesterday's giveaway must not count against today's budget.
    await sql`
      update public.credit_entries set created_at = now() - interval '25 hours'
       where user_id = ${uid(16)} and ref_type = 'welcome'`;

    assert.equal(await grantedSoFar(), before, 'it has fallen out of the window');

    // Which means the headroom is back, and the next user is served.
    await signUp(uid(17));
    assert.deepEqual(await balanceOf(uid(17)), { free: 100, paid: 0 });
  });

  it('treats a cap of zero as no ceiling', async () => {
    await setting('welcome_daily_cap', '0');
    for (let i = 20; i < 25; i++) await signUp(uid(i));
    assert.deepEqual(await balanceOf(uid(24)), { free: 100, paid: 0 });
  });
});

describe('when the grant goes wrong', () => {
  it('never stops an account being created', async () => {
    // The trigger shares a transaction with the insert into auth.users, so an
    // error that propagates would mean nobody can sign in — trading "no free
    // credits, top them up later" for "the app does not start".
    await setting('welcome_credits', '"not a number"');

    await assert.doesNotReject(() => signUp(uid(30)));
    assert.equal(await exists(uid(30)), true, 'the account survives a broken setting');
    assert.equal(await balanceOf(uid(30)), null);
  });

  it('keeps working for the next user once the setting is fixed', async () => {
    await setting('welcome_credits', '"not a number"');
    await signUp(uid(31));

    await setting('welcome_credits', '100');
    await signUp(uid(32));
    assert.deepEqual(await balanceOf(uid(32)), { free: 100, paid: 0 });
  });
});
