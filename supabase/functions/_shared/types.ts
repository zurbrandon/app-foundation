// App Foundation — gateway types.
//
// Deliberately runtime-agnostic: no Deno globals in this file or in
// gateway.ts, so the same source runs in Edge Functions and under `node
// --experimental-strip-types` in the test suite. Only ai-gateway/index.ts
// touches Deno.

/** What an app sends. Normalised across providers. */
export type GatewayInput = {
  system?: string;
  text?: string;
  image?: { base64: string; mediaType: string };
  /** Ask for structured output. Providers map this to their own mechanism. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

export type GatewayRequest = {
  operation: string;
  input: GatewayInput;
  /**
   * Client-supplied and stable across retries. It keys the credit reservation,
   * so a request retried after a dropped connection reuses the original hold
   * instead of taking a second one.
   */
  requestId: string;
};

export type OperationConfig = {
  operation: string;
  provider: string;
  model: string;
  charge_mode: 'flat' | 'metered';
  credits_flat: number | null;
  credits_estimate: number | null;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cached_input_usd_per_mtok: number | null;
  max_output_tokens: number;
  params: Record<string, unknown>;
  enabled: boolean;
};

export type ProviderCall = {
  model: string;
  input: GatewayInput;
  maxOutputTokens: number;
  params: Record<string, unknown>;
  signal: AbortSignal;
};

export type ProviderResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type Provider = (call: ProviderCall, apiKey: string) => Promise<ProviderResult>;

export type GatewayResult = {
  text: string;
  operation: string;
  /** What the user was charged. */
  creditsCharged: number;
  /** Balance after the charge, so a client never has to re-fetch it. */
  balance: { free: number; paid: number };
};

export type GatewayErrorCode =
  | 'unknown_operation'
  | 'operation_disabled'
  | 'insufficient_credits'
  | 'invalid_request'
  | 'provider_error'
  | 'timeout';

/**
 * Errors the caller is meant to handle, as opposed to faults.
 *
 * Fields are declared and assigned rather than written as constructor
 * parameter properties: those emit code rather than only types, so Node's
 * strip-only TypeScript mode rejects them and the test suite couldn't import
 * this file.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;

  constructor(code: GatewayErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}
