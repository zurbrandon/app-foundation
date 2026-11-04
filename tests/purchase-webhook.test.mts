// App Foundation — the webhook layer, against a stubbed ledger.
//
// purchases.test.mjs proves the SQL is right. This proves the layer in front
// of it is: that a bad secret never reaches the ledger, that event types map
// to the right effect, and that every legitimate outcome is a 200 so the
// provider stops redelivering.
//
// The secret comparison gets its own tests because it is the only thing
// standing between this endpoint and anyone who finds the URL — there is no
// user JWT here to fall back on.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent,
  parseRevenueCat,
  secretMatches,
  type PurchaseEvent,
  type PurchaseLedger,
  type Verdict,
} from '../supabase/functions/_shared/purchases.ts';

function stubLedger() {
  const calls: { fn: string; event: PurchaseEvent }[] = [];
  const ledger: PurchaseLedger = {
    recordPurchase: async (event) => {
      calls.push({ fn: 'recordPurchase', event });
      return { applied: true, status: 'credited', credits: 500 } as Verdict;
    },
    recordRefund: async (event) => {
      calls.push({ fn: 'recordRefund', event });
      return { applied: true, status: 'reversed', credits: -500 } as Verdict;
    },
  };
  return { ledger, calls };
}

const body = (over: Record<string, unknown> = {}) => ({
  event: {
    id: 'rc-evt-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: '11111111-1111-1111-1111-111111111111',
    product_id: 'wearwell.credits_500',
    environment: 'PRODUCTION',
    ...over,
  },
});

let stub: ReturnType<typeof stubLedger>;
beforeEach(() => { stub = stubLedger(); });

describe('reading a provider event', () => {
  it('pulls out the id, user and product', () => {
    const e = parseRevenueCat(body())!;
    assert.equal(e.id, 'rc-evt-1');
    assert.equal(e.userId, '11111111-1111-1111-1111-111111111111');
    assert.equal(e.productId, 'wearwell.credits_500');
    assert.equal(e.effect, 'credit');
  });

  it('treats the purchase-shaped events as credits', () => {
    for (const type of ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'RENEWAL', 'UNCANCELLATION']) {
      assert.equal(parseRevenueCat(body({ type }))!.effect, 'credit', type);
    }
  });

  it('treats the money-back events as reversals', () => {
    for (const type of ['CANCELLATION', 'REFUND', 'EXPIRATION']) {
      assert.equal(parseRevenueCat(body({ type }))!.effect, 'reverse', type);
    }
  });

  it('ignores event types it does not know, rather than failing on them', () => {
    // Providers add event types over time. Treating a new one as an error
    // would have them redeliver it forever.
    assert.equal(parseRevenueCat(body({ type: 'SUBSCRIBER_ALIAS' }))!.effect, 'ignore');
    assert.equal(parseRevenueCat(body({ type: 'TEST' }))!.effect, 'ignore');
  });

  it('returns nothing for a body with no event in it', () => {
    assert.equal(parseRevenueCat({}), null);
    assert.equal(parseRevenueCat(null), null);
    assert.equal(parseRevenueCat({ event: 'not an object' }), null);
  });

  it('reads the environment, because TestFlight purchases are sandbox ones', () => {
    assert.equal(parseRevenueCat(body({ environment: 'PRODUCTION' }))!.sandbox, false);
    assert.equal(parseRevenueCat(body({ environment: 'SANDBOX' }))!.sandbox, true);
  });

  it('treats a missing or unrecognised environment as sandbox', () => {
    // The safe reading of "I cannot tell" is "this may not have been paid for".
    assert.equal(parseRevenueCat(body({ environment: undefined }))!.sandbox, true);
    assert.equal(parseRevenueCat(body({ environment: 'STAGING' }))!.sandbox, true);
  });

  it('returns nothing without an id, since there would be no way to dedupe', () => {
    assert.equal(parseRevenueCat(body({ id: undefined })), null);
    assert.equal(parseRevenueCat(body({ id: 42 })), null);
  });

  it('keeps a missing user as null rather than guessing', () => {
    // An unmatched user is refused downstream and recorded. Inventing one here
    // would credit the wrong account.
    const e = parseRevenueCat(body({ app_user_id: undefined }))!;
    assert.equal(e.userId, null);
  });
});

describe('applying an event', () => {
  it('sends a purchase to the credit path', async () => {
    const v = await applyEvent(stub.ledger, parseRevenueCat(body())!, body());
    assert.equal(v.status, 'credited');
    assert.deepEqual(stub.calls.map((c) => c.fn), ['recordPurchase']);
  });

  it('sends a refund to the reversal path', async () => {
    const e = parseRevenueCat(body({ type: 'CANCELLATION' }))!;
    const v = await applyEvent(stub.ledger, e, body());
    assert.equal(v.status, 'reversed');
    assert.deepEqual(stub.calls.map((c) => c.fn), ['recordRefund']);
  });

  it('never touches the ledger for an event with no credit effect', async () => {
    const e = parseRevenueCat(body({ type: 'SUBSCRIBER_ALIAS' }))!;
    const v = await applyEvent(stub.ledger, e, body());

    assert.equal(v.status, 'ignored');
    assert.equal(v.applied, false);
    assert.deepEqual(stub.calls, [], 'the ledger was not called at all');
  });
});

describe('the shared secret', () => {
  it('accepts the right one', () => {
    assert.equal(secretMatches('sk-correct-horse', 'sk-correct-horse'), true);
  });

  it('rejects a wrong one, a short one, and a long one', () => {
    assert.equal(secretMatches('sk-wrong', 'sk-correct-horse'), false);
    assert.equal(secretMatches('sk-correct', 'sk-correct-horse'), false);
    assert.equal(secretMatches('sk-correct-horse-extra', 'sk-correct-horse'), false);
  });

  it('accepts the secret with a Bearer prefix too', () => {
    // RevenueCat's docs do not say whether it sends the configured value
    // verbatim or wraps it, and a webhook silently rejecting every delivery
    // over seven characters is a miserable thing to debug.
    assert.equal(secretMatches('Bearer sk-correct-horse', 'sk-correct-horse'), true);
    assert.equal(secretMatches('Bearer sk-wrong', 'sk-correct-horse'), false);
  });

  it('rejects a missing header', () => {
    assert.equal(secretMatches(null, 'sk-correct-horse'), false);
    assert.equal(secretMatches('', 'sk-correct-horse'), false);
  });

  it('rejects everything when no secret is configured', () => {
    // Failing closed matters most here: an endpoint that mints credits must
    // never be open because somebody forgot to set an environment variable.
    assert.equal(secretMatches('anything', undefined), false);
    assert.equal(secretMatches('anything', ''), false);
    assert.equal(secretMatches(null, undefined), false);
  });

  // There is deliberately no test asserting the comparison is constant time.
  // One was written and it passed against a deliberately leaky early-exit
  // implementation: at 64 bytes the TextEncoder allocation dominates, so the
  // signal it claimed to measure was buried in noise. A security test that
  // passes against the vulnerable version is worse than no test, because it
  // converts "unverified" into "verified" without doing any work.
  //
  // The implementation is constant time by construction — it folds the length
  // difference into the same accumulator as the bytes and always walks the
  // full length — and that is what is relied on, not a measurement.
});
