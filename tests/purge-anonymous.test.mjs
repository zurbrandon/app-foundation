// App Foundation — purging abandoned anonymous users.
//
// Run against a local Supabase Postgres (`supabase start`), never a deployed
// project: these create and delete auth.users rows.
//
// This function deletes real user accounts, and deleting auth.users cascades
// into credit_balances and credit_entries. So the cases that matter are not
// "does it delete" but "what does it refuse to delete" — above all a user
// holding paid credits, which is money that changed hands.

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';

let sql;

/** An anonymous user, optionally backdated to look abandoned. */
async function anonUser(id, { ageDays = 0, anonymous = true } = {}) {
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
                            created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${anonymous ? null : `u${id.slice(0, 8)}@example.com`},
            ${anonymous}, now() - (${ageDays} || ' days')::interval, now())
    on conflict (id) do nothing`;
}

const exists = async (id) =>
  (await sql`select 1 from auth.users where id = ${id}`).length > 0;

const purge = async (older = '30 days') =>
  (await sql`select foundation.purge_abandoned_anonymous(${older}::interval) as n`)[0].n;

const grant = (user, amount, bucket, kind) =>
  sql`select foundation.grant_credits(${user}, ${amount}, ${bucket}::foundation.credit_bucket,
                                      ${kind}::foundation.credit_kind, ${`k-${user}-${bucket}`})`;

const ID = {
  oldAnon: 'aaaaaaaa-0000-0000-0000-000000000001',
  freshAnon: 'aaaaaaaa-0000-0000-0000-000000000002',
  paidAnon: 'aaaaaaaa-0000-0000-0000-000000000003',
  oldReal: 'aaaaaaaa-0000-0000-0000-000000000004',
  freeAnon: 'aaaaaaaa-0000-0000-0000-000000000005',
};

before(() => { sql = postgres(URL, { max: 4, onnotice: () => {} }); });
after(async () => { await sql.end(); });

beforeEach(async () => {
  await sql`delete from auth.users where id = any(${Object.values(ID)})`;
});

describe('purging abandoned anonymous users', () => {
  it('removes one that is anonymous, old, and holds nothing', async () => {
    await anonUser(ID.oldAnon, { ageDays: 60 });
    assert.equal(await purge(), 1);
    assert.equal(await exists(ID.oldAnon), false);
  });

  it('keeps a recent one, who may still be using the app', async () => {
    await anonUser(ID.freshAnon, { ageDays: 2 });
    assert.equal(await purge(), 0);
    assert.equal(await exists(ID.freshAnon), true);
  });

  it('never removes one holding paid credits, however old', async () => {
    // Purchases are meant to be impossible while anonymous. If one has paid
    // credits anyway, that is money and a bug — not a row to drop quietly.
    await anonUser(ID.paidAnon, { ageDays: 400 });
    await grant(ID.paidAnon, 500, 'paid', 'purchase');

    assert.equal(await purge(), 0);
    assert.equal(await exists(ID.paidAnon), true);

    const [{ paid }] = await sql`select paid from credit_balances where user_id = ${ID.paidAnon}`;
    assert.equal(Number(paid), 500, 'their balance must be untouched too');
  });

  it('does remove one holding only free credits', async () => {
    // Free credits are ours to give and cost nobody anything.
    await anonUser(ID.freeAnon, { ageDays: 60 });
    await grant(ID.freeAnon, 25, 'free', 'grant');

    assert.equal(await purge(), 1);
    assert.equal(await exists(ID.freeAnon), false);
  });

  it('never touches an account somebody secured', async () => {
    await anonUser(ID.oldReal, { ageDays: 400, anonymous: false });
    assert.equal(await purge(), 0);
    assert.equal(await exists(ID.oldReal), true);
  });

  it('refuses a window short enough to delete live users', async () => {
    await anonUser(ID.freshAnon, { ageDays: 0 });
    await assert.rejects(() => purge('1 hour'), /refusing to purge/i);
    assert.equal(await exists(ID.freshAnon), true);
  });

  it('sweeps a mixed population correctly in one pass', async () => {
    await anonUser(ID.oldAnon, { ageDays: 60 });
    await anonUser(ID.freshAnon, { ageDays: 1 });
    await anonUser(ID.paidAnon, { ageDays: 60 });
    await grant(ID.paidAnon, 100, 'paid', 'purchase');
    await anonUser(ID.oldReal, { ageDays: 60, anonymous: false });

    assert.equal(await purge(), 1, 'only the abandoned, unpaid, anonymous one');
    assert.deepEqual(
      {
        oldAnon: await exists(ID.oldAnon),
        freshAnon: await exists(ID.freshAnon),
        paidAnon: await exists(ID.paidAnon),
        oldReal: await exists(ID.oldReal),
      },
      { oldAnon: false, freshAnon: true, paidAnon: true, oldReal: true }
    );
  });
});
