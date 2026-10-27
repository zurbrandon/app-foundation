// App Foundation — AI gateway tests.
//
// Real ledger, real database, stubbed provider. That combination is the point:
// the expensive failure modes are all about what happens to a user's credits
// when a provider misbehaves, and none of them need a real API key to
// reproduce.
//
// Run with: npm test   (node --experimental-strip-types)

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';

import { Ledger } from '../supabase/functions/_shared/ledger.ts';
import { runOperation } from '../supabase/functions/_shared/gateway.ts';
import { GatewayError } from '../supabase/functions/_shared/types.ts';
import type { Provider, ProviderResult } from '../supabase/functions/_shared/types.ts';

const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';
const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54421';
// Local-only key, identical on every `supabase start`. Never a deployed one.
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const USER = '33333333-3333-3333-3333-333333333333';

let sql: ReturnType<typeof postgres>;
let admin: SupabaseClient;
let ledger: Ledger;

/** A provider that returns fixed token counts, so cost is predictable. */
function stubProvider(result: Partial<ProviderResult> = {}): Provider {
  return async () => ({
    text: result.text ?? '{"ok":true}',
    inputTokens: result.inputTokens ?? 1000,
    outputTokens: result.outputTokens ?? 200,
    cachedInputTokens: result.cachedInputTokens ?? 0,
  });
}

const failingProvider =
  (name = 'Error'): Provider =>
  async () => {
    const error = new Error('upstream exploded');
    error.name = name;
    throw error;
  };

function deps(provider: Provider) {
  return {
    ledger,
    providers: { stub: provider },
    apiKeys: { stub: 'test-key' },
  };
}

const run = (provider: Provider, operation: string, requestId: string) =>
  runOperation(deps(provider), USER, {
    operation,
    input: { text: 'hello' },
    requestId,
  });

async function balance() {
  const [row] = await sql`select free, paid from public.credit_balances where user_id = ${USER}`;
  return row ? { free: Number(row.free), paid: Number(row.paid) } : { free: 0, paid: 0 };
}

async function usage(operation: string) {
  return sql`select * from foundation.ai_usage
              where user_id = ${USER} and operation = ${operation}
              order by created_at desc`;
}

before(async () => {
  sql = postgres(DB_URL, { onnotice: () => {} });
  admin = createClient(API_URL, SERVICE_KEY, { auth: { persistSession: false } });
  ledger = new Ledger(admin);

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
    values (${USER}, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', 'gateway-test@example.com', now(), now())
    on conflict (id) do nothing`;

  // A cheap, predictable operation — garment tagging is the real example.
  await sql`
    insert into foundation.ai_operations
      (operation, provider, model, charge_mode, credits_flat,
       input_usd_per_mtok, output_usd_per_mtok, max_output_tokens)
    values ('test.flat', 'stub', 'stub-small', 'flat', 2, 1.0, 5.0, 512)
    on conflict (operation) do update set enabled = true, credits_flat = 2`;

  // An expensive one whose true cost isn't known until it returns.
  await sql`
    insert into foundation.ai_operations
      (operation, provider, model, charge_mode, credits_estimate,
       input_usd_per_mtok, output_usd_per_mtok, max_output_tokens)
    values ('test.metered', 'stub', 'stub-large', 'metered', 500, 5.0, 25.0, 4096)
    on conflict (operation) do update set enabled = true, credits_estimate = 500`;

  await sql`
    insert into foundation.ai_operations
      (operation, provider, model, charge_mode, credits_flat,
       input_usd_per_mtok, output_usd_per_mtok, enabled)
    values ('test.disabled', 'stub', 'stub-small', 'flat', 1, 1.0, 5.0, false)
    on conflict (operation) do update set enabled = false`;
});

after(async () => {
  await sql`delete from foundation.ai_usage where user_id = ${USER}`;
  await sql`delete from foundation.ai_operations where operation like 'test.%'`;
  await sql`delete from auth.users where id = ${USER}`;
  await sql.end();
});

beforeEach(async () => {
  await sql`delete from foundation.ai_usage where user_id = ${USER}`;
  await sql`delete from public.credit_entries where user_id = ${USER}`;
  await sql`delete from public.credit_reservations where user_id = ${USER}`;
  await sql`delete from public.credit_balances where user_id = ${USER}`;
  await sql`
    select foundation.grant_credits(${USER}, 1000, 'paid'::foundation.credit_bucket,
                                   'purchase'::foundation.credit_kind, 'gateway-seed')`;
});

describe('routing', () => {
  it('rejects an unknown operation before charging anything', async () => {
    await assert.rejects(
      () => run(stubProvider(), 'test.nope', 'r1'),
      (e: GatewayError) => e.code === 'unknown_operation'
    );
    assert.deepEqual(await balance(), { free: 0, paid: 1000 });
  });

  it('refuses a disabled operation', async () => {
    await assert.rejects(
      () => run(stubProvider(), 'test.disabled', 'r1'),
      (e: GatewayError) => e.code === 'operation_disabled'
    );
    assert.deepEqual(await balance(), { free: 0, paid: 1000 });
  });

  it('never lets the client choose the model', async () => {
    // The model is whatever config says, regardless of what the caller sends.
    let seenModel = '';
    const spy: Provider = async (call) => {
      seenModel = call.model;
      return { text: 'ok', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };
    };

    await runOperation(deps(spy), USER, {
      operation: 'test.flat',
      // A hostile client trying to upgrade itself to an expensive model.
      input: { text: 'hi', model: 'gpt-nonsense' } as never,
      requestId: 'r1',
    });

    assert.equal(seenModel, 'stub-small');
  });
});

describe('flat charging', () => {
  it('charges the configured amount regardless of tokens used', async () => {
    const cheap = await run(stubProvider({ inputTokens: 10, outputTokens: 5 }), 'test.flat', 'r1');
    assert.equal(cheap.creditsCharged, 2);

    await sql`delete from public.credit_entries where user_id = ${USER} and idempotency_key like 'r1%'`;
    const pricey = await run(
      stubProvider({ inputTokens: 100000, outputTokens: 4000 }),
      'test.flat',
      'r2'
    );
    assert.equal(pricey.creditsCharged, 2, 'a flat operation must not become a meter');
  });

  it('records real provider cost even though the user paid a flat rate', async () => {
    await run(stubProvider({ inputTokens: 1000, outputTokens: 200 }), 'test.flat', 'r1');

    const [row] = await usage('test.flat');
    assert.equal(row.status, 'ok');
    assert.equal(Number(row.credits_charged), 2);
    // 1000 in @ $1/MTok + 200 out @ $5/MTok = $0.001 + $0.001 = $0.002
    assert.equal(Number(row.cost_usd).toFixed(6), '0.002000');
  });
});

describe('metered charging', () => {
  it('settles at measured cost, refunding the rest of the hold', async () => {
    // 1000 in @ $5/MTok + 200 out @ $25/MTok = $0.005 + $0.005 = $0.01
    // -> 10 credits at 1000 credits/USD.
    const result = await run(stubProvider(), 'test.metered', 'r1');

    assert.equal(result.creditsCharged, 10);
    assert.deepEqual(await balance(), { free: 0, paid: 990 }, 'the other 490 held must return');
  });

  it('caps a runaway generation at the amount held', async () => {
    // Far more output than the estimate covers: 1M output @ $25/MTok = $25
    // -> 25,000 credits, way past the 500 reserved.
    const result = await run(
      stubProvider({ inputTokens: 1000, outputTokens: 1_000_000 }),
      'test.metered',
      'r1'
    );

    assert.equal(result.creditsCharged, 500, 'must not charge beyond the hold');
    assert.deepEqual(await balance(), { free: 0, paid: 500 });
  });
});

describe('failure handling', () => {
  it('charges nothing when the provider errors', async () => {
    await assert.rejects(
      () => run(failingProvider(), 'test.metered', 'r1'),
      (e: GatewayError) => e.code === 'provider_error'
    );

    assert.deepEqual(await balance(), { free: 0, paid: 1000 }, 'the hold must be released in full');

    const [row] = await usage('test.metered');
    assert.equal(row.status, 'provider_error');
    assert.equal(Number(row.credits_charged), 0);
  });

  it('charges nothing when the provider times out', async () => {
    await assert.rejects(
      () => run(failingProvider('AbortError'), 'test.metered', 'r1'),
      (e: GatewayError) => e.code === 'timeout'
    );

    assert.deepEqual(await balance(), { free: 0, paid: 1000 });
    const [row] = await usage('test.metered');
    assert.equal(row.status, 'timeout');
  });

  it('leaves no open reservation behind after a failure', async () => {
    await assert.rejects(() => run(failingProvider(), 'test.metered', 'r1'), GatewayError);

    const open = await sql`
      select count(*) from public.credit_reservations
       where user_id = ${USER} and status = 'open'`;
    assert.equal(Number(open[0].count), 0);
  });

  it('refuses the call when the user cannot afford the hold', async () => {
    await sql`delete from public.credit_entries where user_id = ${USER}`;
    await sql`update public.credit_balances set free = 0, paid = 1 where user_id = ${USER}`;

    let called = false;
    const spy: Provider = async () => {
      called = true;
      return { text: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    };

    await assert.rejects(
      () => run(spy, 'test.metered', 'r1'),
      (e: GatewayError) => e.code === 'insufficient_credits'
    );
    assert.equal(called, false, 'must not spend provider money it cannot bill for');
  });
});

describe('retries', () => {
  it('reuses the original hold when a request is retried', async () => {
    // Same requestId twice: the second reserve is idempotent, so the user is
    // held once — not twice for one logical operation.
    await run(stubProvider(), 'test.metered', 'same-id');
    const afterFirst = await balance();

    await run(stubProvider(), 'test.metered', 'same-id');
    const afterSecond = await balance();

    const reservations = await sql`
      select count(*) from public.credit_reservations where user_id = ${USER}`;
    assert.equal(Number(reservations[0].count), 1, 'a retry must not take a second hold');
    assert.ok(
      afterSecond.paid >= afterFirst.paid - 10,
      'a retry must not double-charge'
    );
  });
});
