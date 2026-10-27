// App Foundation — the gateway's view of the credit ledger.
//
// Thin wrapper over the `foundation.*` SQL functions. Every method needs a
// service_role client; with an anon or authenticated key these calls fail with
// permission denied, which is the whole point of the boundary.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OperationConfig } from './types.ts';
import { GatewayError } from './types.ts';

export type Balance = { free: number; paid: number };
export type Reservation = { id: string; amount: number };

/** Postgres SQLSTATEs the SQL layer raises deliberately. */
const SQLSTATE = {
  badRequest: 'PT400',
  forbidden: 'PT403',
  notFound: 'PT404',
  insufficient: 'PT402',
} as const;

function sqlstateOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export class Ledger {
  // Declared and assigned rather than a constructor parameter property, which
  // Node's strip-only TypeScript mode rejects.
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async resolveOperation(operation: string): Promise<OperationConfig> {
    const { data, error } = await this.db
      .schema('foundation')
      .rpc('resolve_operation', { p_operation: operation })
      .single();

    if (error) {
      const code = sqlstateOf(error);
      if (code === SQLSTATE.notFound) {
        throw new GatewayError('unknown_operation', `Unknown operation: ${operation}`, 400);
      }
      if (code === SQLSTATE.forbidden) {
        throw new GatewayError('operation_disabled', `Operation is disabled: ${operation}`, 403);
      }
      throw error;
    }

    return data as OperationConfig;
  }

  /**
   * Hold credits before calling a provider.
   *
   * Both charge modes reserve, not just metered ones: the reservation is what
   * makes concurrent requests safe. Without it, a user with one credit could
   * fire fifty requests in parallel and have all fifty pass a balance check
   * before any of them deducted. Flat operations simply settle at a fixed
   * amount rather than at measured cost.
   */
  async reserve(
    userId: string,
    credits: number,
    operation: string,
    idempotencyKey: string
  ): Promise<Reservation> {
    const { data, error } = await this.db
      .schema('foundation')
      .rpc('reserve_credits', {
        p_user: userId,
        p_amount: credits,
        p_operation: operation,
        p_idempotency_key: idempotencyKey,
      })
      .single();

    if (error) {
      if (sqlstateOf(error) === SQLSTATE.insufficient) {
        throw new GatewayError('insufficient_credits', 'Not enough credits', 402);
      }
      throw error;
    }

    const row = data as { id: string; amount: number };
    return { id: row.id, amount: Number(row.amount) };
  }

  async settle(reservationId: string, actualCredits: number): Promise<Balance> {
    const { data, error } = await this.db
      .schema('foundation')
      .rpc('settle_reservation', {
        p_reservation_id: reservationId,
        p_actual_amount: actualCredits,
      })
      .single();

    if (error) throw error;
    return toBalance(data);
  }

  async release(reservationId: string, reason: string): Promise<Balance> {
    const { data, error } = await this.db
      .schema('foundation')
      .rpc('release_reservation', {
        p_reservation_id: reservationId,
        p_reason: reason,
      })
      .single();

    if (error) throw error;
    return toBalance(data);
  }

  async computeCostUsd(
    operation: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number
  ): Promise<number> {
    const { data, error } = await this.db.schema('foundation').rpc('compute_cost_usd', {
      p_operation: operation,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_cached_input_tokens: cachedInputTokens,
    });

    if (error) throw error;
    return Number(data ?? 0);
  }

  async usdToCredits(usd: number): Promise<number> {
    const { data, error } = await this.db
      .schema('foundation')
      .rpc('usd_to_credits', { p_usd: usd });

    if (error) throw error;
    return Number(data ?? 0);
  }

  async balance(userId: string): Promise<Balance> {
    const { data, error } = await this.db
      .from('credit_balances')
      .select('free, paid')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return toBalance(data);
  }

  /** Never carries prompt or response text — see 0003_ai_gateway.sql. */
  async recordUsage(entry: {
    userId: string | null;
    operation: string;
    provider: string;
    model: string;
    status: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
    credits?: number;
    latencyMs?: number | null;
    errorCode?: string | null;
    reservationId?: string | null;
    requestId?: string | null;
  }): Promise<void> {
    const { error } = await this.db.schema('foundation').rpc('record_usage', {
      p_user_id: entry.userId,
      p_operation: entry.operation,
      p_provider: entry.provider,
      p_model: entry.model,
      p_status: entry.status,
      p_input_tokens: entry.inputTokens ?? 0,
      p_output_tokens: entry.outputTokens ?? 0,
      p_cached_tokens: entry.cachedTokens ?? 0,
      p_cost_usd: entry.costUsd ?? 0,
      p_credits: entry.credits ?? 0,
      p_latency_ms: entry.latencyMs ?? null,
      p_error_code: entry.errorCode ?? null,
      p_reservation_id: entry.reservationId ?? null,
      p_request_id: entry.requestId ?? null,
    });

    // Usage logging must never take down a request that already succeeded and
    // was already charged. Surface it and move on.
    if (error) console.error('record_usage failed', error);
  }
}

function toBalance(row: unknown): Balance {
  const value = (row ?? {}) as { free?: number | string; paid?: number | string };
  return { free: Number(value.free ?? 0), paid: Number(value.paid ?? 0) };
}
