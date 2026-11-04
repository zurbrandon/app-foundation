// App Foundation — turning a provider's webhook into a ledger entry.
//
// Runtime-agnostic, like gateway.ts: no Deno globals here, so the test suite
// runs this exact code under Node with a stubbed ledger. The money paths are
// the reason that matters.
//
// RevenueCat is the shape modelled, because familiar on iOS must use Apple IAP
// for digital credits and RevenueCat is the usual wrapper. Nothing below is
// RevenueCat-specific beyond `eventsFrom` — Stripe, which Understory would
// need on macOS outside the Mac App Store, is another parser feeding the same
// two calls.

export type PurchaseEvent = {
  /** The provider's own id. Carries idempotency; without it we cannot dedupe. */
  id: string;
  type: string;
  userId: string | null;
  productId: string | null;
  /**
   * SANDBOX for a store transaction that cost nobody anything.
   *
   * This matters more than it looks: TestFlight purchases are sandbox
   * purchases. Crediting them unconditionally means any tester can buy the
   * same pack repeatedly, for free, and receive real credits.
   */
  sandbox: boolean;
  /** Credit it, take it back, or neither. */
  effect: 'credit' | 'reverse' | 'ignore';
};

export type Verdict = {
  applied: boolean;
  status: string;
  credits?: number;
  shortfall?: number;
  anonymous?: boolean;
  note?: string | null;
};

export interface PurchaseLedger {
  recordPurchase(e: PurchaseEvent, payload: unknown): Promise<Verdict>;
  recordRefund(e: PurchaseEvent, payload: unknown): Promise<Verdict>;
}

/**
 * Which RevenueCat events move credits.
 *
 * Everything unrecognised is ignored rather than rejected. A provider adds
 * event types over time, and an unknown one is not a failure — answering
 * anything but 200 would have them retry it forever.
 */
const CREDIT = new Set([
  'INITIAL_PURCHASE',
  'NON_RENEWING_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
]);

const REVERSE = new Set(['CANCELLATION', 'REFUND', 'EXPIRATION']);

export function parseRevenueCat(body: unknown): PurchaseEvent | null {
  const event = (body as { event?: Record<string, unknown> } | null)?.event;
  if (!event || typeof event !== 'object') return null;

  const id = typeof event.id === 'string' ? event.id : null;
  const type = typeof event.type === 'string' ? event.type : null;
  if (!id || !type) return null;

  // app_user_id is whatever the app told RevenueCat to call this person. The
  // client sets it to the Supabase user id at login; anything else cannot be
  // matched to an account and will be refused downstream rather than guessed.
  const userId = typeof event.app_user_id === 'string' ? event.app_user_id : null;
  const productId = typeof event.product_id === 'string' ? event.product_id : null;

  // Default to treating an unknown environment as sandbox. If the field is
  // missing or renamed, the safe reading is "this may not have been paid for".
  const sandbox = String(event.environment ?? 'SANDBOX').toUpperCase() !== 'PRODUCTION';

  return {
    id,
    type,
    userId,
    productId,
    sandbox,
    effect: CREDIT.has(type) ? 'credit' : REVERSE.has(type) ? 'reverse' : 'ignore',
  };
}

/**
 * Apply one event.
 *
 * Every outcome here is a 200 to the provider. A duplicate is not an error, an
 * unknown product will not become known by retrying, and an unrecognised event
 * type is none of our business. The only things worth a non-2xx — and so worth
 * a retry — are a bad signature and a database that is down, both of which are
 * handled by the caller.
 */
export async function applyEvent(
  ledger: PurchaseLedger,
  event: PurchaseEvent,
  payload: unknown
): Promise<Verdict> {
  if (event.effect === 'ignore') {
    return { applied: false, status: 'ignored', note: `no credit effect for ${event.type}` };
  }

  return event.effect === 'credit'
    ? ledger.recordPurchase(event, payload)
    : ledger.recordRefund(event, payload);
}

/**
 * Constant-time string comparison.
 *
 * The shared secret is the only thing standing between this endpoint and
 * anyone who can guess its URL. A plain `===` leaks the length of the matching
 * prefix through timing, which is enough to recover a secret byte by byte given
 * patience, and a webhook endpoint grants a patient attacker unlimited attempts.
 */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;

  // Tolerate a Bearer prefix. RevenueCat's docs do not say whether it sends the
  // configured value verbatim or wraps it, and a webhook that silently rejects
  // every delivery because of seven characters is a miserable thing to debug.
  const value = provided.startsWith('Bearer ') ? provided.slice(7) : provided;

  const a = new TextEncoder().encode(value);
  const b = new TextEncoder().encode(expected);

  // Comparing lengths first would itself be a timing signal, so fold the
  // length difference into the same accumulator as the bytes.
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
