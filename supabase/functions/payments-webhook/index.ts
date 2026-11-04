// App Foundation — payments webhook.
//
// The only Deno-specific file in the purchase path. Everything it wires
// together lives in _shared/purchases.ts and is exercised by the Node tests.
//
// This endpoint is how credits come into existence for money, which makes the
// shared secret the single thing standing between it and anyone who finds the
// URL. There is no user JWT here — the caller is a provider, not a person — so
// unlike the gateway there is no second identity to fall back on.

import { createClient } from '@supabase/supabase-js';
import {
  applyEvent,
  parseRevenueCat,
  secretMatches,
  type PurchaseEvent,
  type Verdict,
} from '../_shared/purchases.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('PAYMENTS_WEBHOOK_SECRET');

const PROVIDER = 'revenuecat';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Refuse to run at all rather than run unauthenticated. An endpoint that
  // mints credits must never be reachable because somebody forgot to set a
  // secret — failing closed costs a deploy, failing open costs money.
  if (!WEBHOOK_SECRET) {
    console.error('PAYMENTS_WEBHOOK_SECRET is not set; refusing every request');
    return json({ error: 'not_configured' }, 503);
  }

  if (!secretMatches(request.headers.get('Authorization'), WEBHOOK_SECRET)) {
    // Deliberately vague, and a 401 so the provider retries — a secret rotated
    // at one end before the other should recover once both match.
    console.warn('rejected a webhook with a bad or missing Authorization header');
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const event = parseRevenueCat(payload);
  if (!event) {
    // Nothing to dedupe on and nothing to act on. Retrying will not improve it.
    console.warn('webhook body was not a recognisable event');
    return json({ status: 'unrecognised' }, 200);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const call = (fn: 'record_purchase' | 'record_refund') => async (e: PurchaseEvent, raw: unknown) => {
    const { data, error } = await db.schema('foundation').rpc(fn, {
      p_provider: PROVIDER,
      p_event_id: e.id,
      p_event_type: e.type,
      p_user: e.userId,
      p_product_id: e.productId,
      p_payload: raw,
      p_sandbox: e.sandbox,
    });
    if (error) throw error;
    return data as Verdict;
  };

  try {
    const verdict = await applyEvent(
      { recordPurchase: call('record_purchase'), recordRefund: call('record_refund') },
      event,
      payload
    );

    // Worth a loud log rather than a quiet row: credits that cannot survive a
    // reinstall have been sold to someone, which means the app offered a
    // purchase it should not have.
    if (verdict.anonymous) {
      console.error(`sold credits to an anonymous account via ${event.id}`);
    }
    if (event.sandbox && verdict.status === 'rejected') {
      console.warn(`sandbox ${event.type} ${event.id} not credited — this is the default`);
    }
    if (verdict.shortfall) {
      console.warn(`refund ${event.id} could not reclaim ${verdict.shortfall} credits`);
    }

    // Every outcome above is a 200. A duplicate is not an error, an unknown
    // product will not become known by retrying, and an event type we do not
    // handle is none of our business — answering otherwise asks the provider
    // to redeliver forever.
    return json({ provider: PROVIDER, event: event.id, ...verdict }, 200);
  } catch (error) {
    // A fault on our side, not a bad request. 500 so the provider retries,
    // and the idempotency key means a successful retry cannot double-credit.
    console.error('payments webhook failed', error);
    return json({ error: 'internal_error' }, 500);
  }
});
