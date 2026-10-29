// App Foundation — the client against a real deployed project.
//
// foundation.test.mts proves the client behaves. This proves the contract in
// docs/http-api.md is *true*: anonymous sign-in, a refused call on an empty
// balance, a real provider call, and a balance that moved by the amount the
// operation says it charges.
//
// Skipped unless FOUNDATION_URL / FOUNDATION_ANON_KEY / FOUNDATION_SERVICE_KEY
// are set, so `npm test` still works for anyone without project keys. The
// service key is used only to grant credits and to delete the throwaway user —
// things a client is specifically not allowed to do.
//
//   FOUNDATION_URL=... FOUNDATION_ANON_KEY=... FOUNDATION_SERVICE_KEY=... \
//     node --experimental-strip-types --test client/live.test.mts

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFoundation, FoundationError } from './foundation.ts';

const URL_ = process.env.FOUNDATION_URL;
const ANON = process.env.FOUNDATION_ANON_KEY;
const SERVICE = process.env.FOUNDATION_SERVICE_KEY;
const OPERATION = process.env.FOUNDATION_TEST_OPERATION ?? 'wearwell.tag_garment';

const configured = Boolean(URL_ && ANON && SERVICE);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE!,
      authorization: `Bearer ${SERVICE}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

let createdUserId: string | null = null;

after(async () => {
  // Never leave a user behind on a real project. Deleting auth.users cascades
  // into the ledger, so this cleans up the balance and entries too.
  if (createdUserId && configured) {
    await admin(`/auth/v1/admin/users/${createdUserId}`, { method: 'DELETE' });
  }
});

describe('the contract, against a deployed project', { skip: !configured }, () => {
  const foundation = configured
    ? createFoundation({ url: URL_!, anonKey: ANON!, storage: memoryStorage(), maxRetries: 1 })
    : (null as never);

  it('signs in anonymously, with no sign-up screen anywhere', async () => {
    const session = await foundation.session();
    createdUserId = session.userId;

    assert.ok(session.userId, 'got a user id');
    assert.equal(session.isAnonymous, true);
    assert.ok(session.expiresAt > Date.now(), 'and a token that has not already expired');
  });

  it('starts at a zero balance rather than erroring on a missing row', async () => {
    assert.deepEqual(await foundation.balance(), { free: 0, paid: 0 });
  });

  it('refuses the call when there is nothing to charge', async () => {
    await assert.rejects(
      () => foundation.run(OPERATION, { text: 'tag this' }),
      (e: FoundationError) => e.code === 'insufficient_credits' && e.status === 402 && !e.retryable
    );
  });

  it('rejects an operation that is not registered', async () => {
    await assert.rejects(
      () => foundation.run('definitely.not.registered', { text: 'x' }),
      (e: FoundationError) => e.code === 'unknown_operation' && !e.retryable
    );
  });

  it('runs for real once credits exist, and charges what the operation says', async () => {
    const granted = await admin('/rest/v1/rpc/grant_credits', {
      method: 'POST',
      headers: { 'Content-Profile': 'foundation' },
      body: JSON.stringify({
        p_user: createdUserId, p_amount: 50, p_bucket: 'free', p_kind: 'grant',
        p_idempotency_key: `live-${createdUserId}`, p_reason: 'client integration test',
      }),
    });
    assert.ok(granted.ok, 'granting credits should succeed');

    const before = await foundation.balance();
    assert.equal(before.free, 50);

    const result = await foundation.run(OPERATION, {
      system: 'Reply with exactly one word.',
      text: 'What category is a plain white cotton oxford shirt? One word.',
    });

    assert.ok(result.text.length > 0, 'the provider returned something');
    assert.equal(result.operation, OPERATION);
    assert.ok(result.creditsCharged > 0, 'a real call costs real credits');

    // The response carries the post-charge balance, so a client never has to
    // re-read it — and it must agree with what the ledger actually did.
    assert.equal(result.balance.free, before.free - result.creditsCharged);
    assert.deepEqual(await foundation.balance(), result.balance);
  });

  it('charges a retried requestId only once', async () => {
    // The property the whole idempotency design exists for: a dropped
    // connection must not cost the user twice. Same requestId, twice.
    const before = await foundation.balance();
    const requestId = crypto.randomUUID();

    const first = await foundation.run(OPERATION, { text: 'Name one colour. One word.' }, { requestId });
    const afterFirst = await foundation.balance();
    assert.equal(afterFirst.free, before.free - first.creditsCharged);

    await foundation.run(OPERATION, { text: 'Name one colour. One word.' }, { requestId });
    const afterSecond = await foundation.balance();

    assert.equal(
      afterSecond.free,
      afterFirst.free,
      'replaying a requestId must not take a second hold'
    );
  });

  it('never lets the client touch the ledger directly', async () => {
    const { accessToken, userId } = await foundation.session();

    const minted = await fetch(`${URL_}/rest/v1/rpc/grant_credits`, {
      method: 'POST',
      headers: { apikey: ANON!, authorization: `Bearer ${accessToken}`,
                 'content-type': 'application/json', 'Content-Profile': 'foundation' },
      body: JSON.stringify({ p_user: userId, p_amount: 1_000_000, p_bucket: 'paid',
                             p_kind: 'grant', p_idempotency_key: 'attack' }),
    });
    assert.ok(!minted.ok, 'a signed-in user must not be able to mint credits');

    const written = await fetch(`${URL_}/rest/v1/credit_balances?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { apikey: ANON!, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ paid: 999_999 }),
    });
    assert.ok(!written.ok, 'nor write the balance table directly');
  });
});
