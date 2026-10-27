// App Foundation — AI gateway core.
//
// Runtime-agnostic on purpose (no Deno globals), so the test suite runs this
// exact code against a real local ledger with a stubbed provider. The money
// paths — what happens when a provider times out, errors, or over-runs its
// estimate — are the reason this is worth testing rather than eyeballing.
//
// The order of operations matters:
//
//   resolve -> reserve -> call provider -> settle -> log
//
// Credits are held *before* the provider is called. Charging afterwards would
// let a user with one credit fire fifty parallel requests, all of which pass a
// balance check before any of them deducts.
//
// Whatever happens after a successful reservation, it is released or settled
// exactly once. A crash between reserve and settle is caught by the expiry
// sweep, so credits are never stranded.

import type { Ledger } from './ledger.ts';
import type {
  GatewayRequest,
  GatewayResult,
  OperationConfig,
  Provider,
  ProviderResult,
} from './types.ts';
import { GatewayError } from './types.ts';

export type GatewayDeps = {
  ledger: Ledger;
  /** Keyed by provider name as stored in `foundation.ai_operations.provider`. */
  providers: Record<string, Provider>;
  /** Resolved per provider, never sent to or stored by a client. */
  apiKeys: Record<string, string | undefined>;
  timeoutMs?: number;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runOperation(
  deps: GatewayDeps,
  userId: string,
  request: GatewayRequest
): Promise<GatewayResult> {
  const now = deps.now ?? Date.now;
  const { ledger } = deps;

  if (!request.operation || typeof request.operation !== 'string') {
    throw new GatewayError('invalid_request', 'operation is required', 400);
  }
  if (!request.requestId || typeof request.requestId !== 'string') {
    throw new GatewayError('invalid_request', 'requestId is required', 400);
  }
  if (!request.input || typeof request.input !== 'object') {
    throw new GatewayError('invalid_request', 'input is required', 400);
  }

  const config = await ledger.resolveOperation(request.operation);

  const provider = deps.providers[config.provider];
  if (!provider) {
    // Config names a provider this deployment can't serve — an operator error,
    // not the user's. Nothing has been charged at this point.
    await ledger.recordUsage({
      userId,
      operation: config.operation,
      provider: config.provider,
      model: config.model,
      status: 'invalid_request',
      errorCode: 'no_provider_adapter',
      requestId: request.requestId,
    });
    throw new GatewayError('invalid_request', `No adapter for provider ${config.provider}`, 500);
  }

  const apiKey = deps.apiKeys[config.provider];
  if (!apiKey) {
    await ledger.recordUsage({
      userId,
      operation: config.operation,
      provider: config.provider,
      model: config.model,
      status: 'invalid_request',
      errorCode: 'missing_api_key',
      requestId: request.requestId,
    });
    throw new GatewayError('invalid_request', `No API key configured for ${config.provider}`, 500);
  }

  const hold = holdFor(config);

  // Keyed by requestId, so a retry reuses the original hold rather than
  // taking a second one against the same user.
  const reservation = await ledger.reserve(
    userId,
    hold,
    config.operation,
    `${request.requestId}:${config.operation}`
  );

  const startedAt = now();
  let result: ProviderResult;

  try {
    result = await callWithTimeout(provider, config, request, apiKey, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (cause) {
    // The provider never produced anything, so the user is charged nothing.
    await ledger.release(reservation.id, 'provider call failed');

    const timedOut = cause instanceof Error && cause.name === 'AbortError';
    await ledger.recordUsage({
      userId,
      operation: config.operation,
      provider: config.provider,
      model: config.model,
      status: timedOut ? 'timeout' : 'provider_error',
      latencyMs: now() - startedAt,
      errorCode: errorCodeOf(cause),
      reservationId: reservation.id,
      requestId: request.requestId,
    });

    throw timedOut
      ? new GatewayError('timeout', 'The model took too long to respond', 504)
      : new GatewayError('provider_error', 'The model provider failed', 502);
  }

  const latencyMs = now() - startedAt;

  const costUsd = await ledger.computeCostUsd(
    config.operation,
    result.inputTokens,
    result.outputTokens,
    result.cachedInputTokens
  );

  // Flat operations cost the user the same every time regardless of how many
  // tokens it took. That predictability is the point: a balance should mean
  // "about this many garments", not a meter the user has to watch.
  const creditsCharged =
    config.charge_mode === 'flat'
      ? (config.credits_flat ?? 0)
      : await ledger.usdToCredits(costUsd);

  const balance = await ledger.settle(reservation.id, creditsCharged);

  await ledger.recordUsage({
    userId,
    operation: config.operation,
    provider: config.provider,
    model: config.model,
    status: 'ok',
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedTokens: result.cachedInputTokens,
    costUsd,
    // What settle actually took, which is capped at the hold.
    credits: Math.min(creditsCharged, reservation.amount),
    latencyMs,
    reservationId: reservation.id,
    requestId: request.requestId,
  });

  return {
    text: result.text,
    operation: config.operation,
    creditsCharged: Math.min(creditsCharged, reservation.amount),
    balance,
  };
}

/**
 * How much to hold.
 *
 * Flat: exactly what will be charged. Metered: the configured estimate, which
 * also caps the user's exposure — settle will never charge beyond it, so a
 * runaway generation can't empty an account.
 */
function holdFor(config: OperationConfig): number {
  const hold = config.charge_mode === 'flat' ? config.credits_flat : config.credits_estimate;

  if (!hold || hold <= 0) {
    throw new GatewayError(
      'invalid_request',
      `Operation ${config.operation} has no credit amount configured`,
      500
    );
  }

  return hold;
}

async function callWithTimeout(
  provider: Provider,
  config: OperationConfig,
  request: GatewayRequest,
  apiKey: string,
  timeoutMs: number
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await provider(
      {
        model: config.model,
        input: request.input,
        maxOutputTokens: config.max_output_tokens,
        params: config.params ?? {},
        signal: controller.signal,
      },
      apiKey
    );
  } finally {
    clearTimeout(timer);
  }
}

function errorCodeOf(cause: unknown): string {
  if (cause instanceof Error) return cause.name === 'AbortError' ? 'timeout' : cause.message.slice(0, 120);
  return 'unknown';
}
