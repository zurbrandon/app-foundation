// App Foundation — credit ledger tests.
//
// Run against a local Supabase Postgres (`supabase start`), never a deployed
// project: these truncate the ledger between cases.
//
// The properties worth proving here are the ones that cost real money when
// they're wrong: a replayed webhook must not grant twice, and concurrent
// requests must not overdraw. Both are tested with genuine parallel
// connections rather than sequential calls, because a sequential test passes
// happily against a ledger with no locking at all.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** One shared connection for setup and assertions. */
let sql;
/** A stable user id per test run; the row is recreated before each case. */
const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

async function makeUser(id, email) {
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${email}, now(), now())
    on conflict (id) do nothing`;
}

async function balance(user = USER) {
  const [row] = await sql`
    select free, paid from public.credit_balances where user_id = ${user}`;
  return row ? { free: Number(row.free), paid: Number(row.paid) } : { free: 0, paid: 0 };
}

/** The invariant: the cached balance must always equal the ledger it caches. */
async function assertReconciles(user = USER) {
  const [row] = await sql`
    select
      coalesce(sum(delta) filter (where bucket = 'free'), 0) as free,
      coalesce(sum(delta) filter (where bucket = 'paid'), 0) as paid
    from public.credit_entries where user_id = ${user}`;
  const cached = await balance(user);
  assert.equal(cached.free, Number(row.free), 'free balance drifted from entries');
  assert.equal(cached.paid, Number(row.paid), 'paid balance drifted from entries');
}

before(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  await makeUser(USER, 'ledger-test@example.com');
  await makeUser(OTHER, 'ledger-other@example.com');
});

after(async () => {
  await sql`delete from auth.users where id in (${USER}, ${OTHER})`;
  await sql.end();
});

beforeEach(async () => {
  await sql`delete from public.credit_entries where user_id in (${USER}, ${OTHER})`;
  await sql`delete from public.credit_reservations where user_id in (${USER}, ${OTHER})`;
  await sql`delete from public.credit_balances where user_id in (${USER}, ${OTHER})`;
});

const grant = (amount, bucket, key, kind = 'grant') =>
  sql`select * from foundation.grant_credits(
        ${USER}, ${amount}, ${bucket}::foundation.credit_bucket,
        ${kind}::foundation.credit_kind, ${key})`;

const spend = (amount, key, conn = sql) =>
  conn`select * from foundation.spend_credits(${USER}, ${amount}, 'test.op', ${key})`;

describe('grants', () => {
  it('adds to the right bucket', async () => {
    await grant(150, 'free', 'k1');
    await grant(500, 'paid', 'k2', 'purchase');
    assert.deepEqual(await balance(), { free: 150, paid: 500 });
    await assertReconciles();
  });

  it('is idempotent — a webhook delivered three times grants once', async () => {
    for (let i = 0; i < 3; i++) await grant(500, 'paid', 'rc-txn-abc', 'purchase');
    assert.deepEqual(await balance(), { free: 0, paid: 500 });

    const [{ count }] = await sql`
      select count(*) from public.credit_entries where idempotency_key = 'rc-txn-abc'`;
    assert.equal(Number(count), 1, 'duplicate entries written');
    await assertReconciles();
  });

  it('rejects a non-positive amount', async () => {
    await assert.rejects(() => grant(0, 'free', 'bad'), /must be positive/);
    await assert.rejects(() => grant(-10, 'free', 'bad2'), /must be positive/);
  });
});

describe('spending', () => {
  it('draws free credits before paid ones', async () => {
    await grant(100, 'free', 'g1');
    await grant(100, 'paid', 'g2', 'purchase');

    await spend(60, 's1');
    assert.deepEqual(await balance(), { free: 40, paid: 100 });
    await assertReconciles();
  });

  it('crosses into paid only once free is exhausted, writing one entry per bucket', async () => {
    await grant(30, 'free', 'g1');
    await grant(100, 'paid', 'g2', 'purchase');

    await spend(50, 's1');
    assert.deepEqual(await balance(), { free: 0, paid: 80 });

    const rows = await sql`
      select bucket, delta from public.credit_entries
       where idempotency_key = 's1' order by bucket`;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.bucket, Number(r.delta)]), [['free', -30], ['paid', -20]]);
    await assertReconciles();
  });

  it('refuses to overdraw, and changes nothing when it does', async () => {
    await grant(40, 'free', 'g1');
    await assert.rejects(() => spend(41, 's1'), /insufficient_credits/);
    assert.deepEqual(await balance(), { free: 40, paid: 0 });
    await assertReconciles();
  });

  it('is idempotent — a retried request charges once', async () => {
    await grant(100, 'free', 'g1');
    for (let i = 0; i < 3; i++) await spend(25, 'retry-key');
    assert.deepEqual(await balance(), { free: 75, paid: 0 });
    await assertReconciles();
  });
});

describe('concurrency', () => {
  it('cannot be overdrawn by parallel requests', async () => {
    // 100 credits, 20 simultaneous attempts to spend 10. Exactly 10 may win.
    await grant(100, 'free', 'g1');

    const attempts = 20;
    const conns = Array.from({ length: attempts }, () => postgres(URL, { max: 1, onnotice: () => {} }));

    try {
      const results = await Promise.allSettled(
        conns.map((conn, i) => spend(10, `parallel-${i}`, conn))
      );

      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter(
        (r) => r.status === 'rejected' && /insufficient_credits/.test(String(r.reason))
      ).length;

      assert.equal(ok, 10, `expected exactly 10 successful spends, got ${ok}`);
      assert.equal(failed, 10, `expected 10 rejections, got ${failed}`);
      assert.deepEqual(await balance(), { free: 0, paid: 0 });
      await assertReconciles();
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });

  it('grants the same key once even when delivered in parallel', async () => {
    const conns = Array.from({ length: 8 }, () => postgres(URL, { max: 1, onnotice: () => {} }));
    try {
      await Promise.allSettled(
        conns.map((conn) =>
          conn`select * from foundation.grant_credits(
                 ${USER}, 500, 'paid'::foundation.credit_bucket,
                 'purchase'::foundation.credit_kind, 'rc-parallel')`
        )
      );
      assert.deepEqual(await balance(), { free: 0, paid: 500 });
      await assertReconciles();
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });
});

describe('reservations', () => {
  const reserve = (amount, key, ttl = '15 minutes') =>
    sql`select * from foundation.reserve_credits(
          ${USER}, ${amount}, 'test.expensive', ${key}, ${ttl}::interval)`;

  it('holds credits up front and refunds the unused remainder', async () => {
    await grant(1000, 'paid', 'g1', 'purchase');

    const [res] = await reserve(300, 'r1');
    assert.deepEqual(await balance(), { free: 0, paid: 700 }, 'reserve should deduct immediately');

    await sql`select * from foundation.settle_reservation(${res.id}, 120)`;
    assert.deepEqual(await balance(), { free: 0, paid: 880 }, 'unused 180 should return');
    await assertReconciles();
  });

  it('caps an over-running operation at the amount reserved', async () => {
    await grant(500, 'paid', 'g1', 'purchase');
    const [res] = await reserve(100, 'r1');

    await sql`select * from foundation.settle_reservation(${res.id}, 400)`;
    assert.deepEqual(await balance(), { free: 0, paid: 400 }, 'must not charge beyond the hold');
    await assertReconciles();
  });

  it('returns credits to the buckets they came from', async () => {
    await grant(50, 'free', 'g1');
    await grant(50, 'paid', 'g2', 'purchase');

    const [res] = await reserve(80, 'r1'); // 50 free + 30 paid
    assert.deepEqual(await balance(), { free: 0, paid: 20 });

    await sql`select * from foundation.release_reservation(${res.id})`;
    assert.deepEqual(await balance(), { free: 50, paid: 50 }, 'free must not become paid');
    await assertReconciles();
  });

  it('settling twice is a no-op', async () => {
    await grant(500, 'paid', 'g1', 'purchase');
    const [res] = await reserve(200, 'r1');

    await sql`select * from foundation.settle_reservation(${res.id}, 50)`;
    await sql`select * from foundation.settle_reservation(${res.id}, 50)`;
    assert.deepEqual(await balance(), { free: 0, paid: 450 });
    await assertReconciles();
  });

  it('sweeps expired holds so a crashed operation cannot strand credits', async () => {
    await grant(500, 'paid', 'g1', 'purchase');
    await reserve(200, 'r1', '-1 minutes'); // already expired
    assert.deepEqual(await balance(), { free: 0, paid: 300 });

    const [{ expire_reservations: swept }] = await sql`select foundation.expire_reservations()`;
    assert.equal(Number(swept), 1);
    assert.deepEqual(await balance(), { free: 0, paid: 500 });
    await assertReconciles();
  });
});

describe('security', () => {
  it('does not let a signed-in client mint credits', async () => {
    const client = postgres(URL, { max: 1, onnotice: () => {} });
    try {
      await client`set role authenticated`;
      await assert.rejects(
        () => client`select foundation.grant_credits(
                       ${USER}, 1000000, 'paid'::foundation.credit_bucket,
                       'grant'::foundation.credit_kind, 'evil')`,
        /permission denied/i,
        'authenticated must not be able to execute ledger functions'
      );
    } finally {
      await client.end();
    }
  });

  it('does not let a client write the balance table directly', async () => {
    await grant(10, 'paid', 'g1', 'purchase');

    const client = postgres(URL, { max: 1, onnotice: () => {} });
    try {
      await client`set role authenticated`;

      // Every write path must be closed. UPDATE and DELETE are the dangerous
      // ones to get wrong: with only RLS in place they match zero rows and
      // report success, so a broken policy would look like a working one.
      await assert.rejects(
        () => client`update public.credit_balances set paid = 999999 where user_id = ${USER}`,
        /permission denied/i
      );
      await assert.rejects(
        () => client`delete from public.credit_balances where user_id = ${USER}`,
        /permission denied/i
      );
      await assert.rejects(
        () => client`insert into public.credit_entries
                       (user_id, delta, kind, bucket, idempotency_key)
                     values (${USER}, 999999, 'grant', 'paid', 'forged')`,
        /permission denied/i
      );
    } finally {
      await client.end();
    }

    // And the balance is what it was.
    assert.deepEqual(await balance(), { free: 0, paid: 10 });
    await assertReconciles();
  });

  it('lets a client read its own balance but not anyone else’s', async () => {
    await grant(42, 'paid', 'g1', 'purchase');

    const client = postgres(URL, { max: 1, onnotice: () => {} });
    try {
      // request.jwt.claims is how Supabase surfaces the signed-in user to RLS.
      await client`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OTHER })}, false)`;
      await client`set role authenticated`;

      const rows = await client`select * from public.credit_balances where user_id = ${USER}`;
      assert.equal(rows.length, 0, 'one user must not see another user’s balance');
    } finally {
      await client.end();
    }
  });
});
