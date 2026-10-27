// App Foundation — ai-gateway Edge Function.
//
// The only Deno-specific file in the gateway. Everything it wires together
// lives in _shared and is exercised by the Node test suite.
//
// Two clients, deliberately:
//
//   - a caller-scoped client built from the request's Authorization header,
//     used only to resolve who is asking. It carries the user's own JWT, so it
//     can do nothing the user couldn't.
//   - a service_role client used for the ledger. The service key never leaves
//     this function.
//
// Resolving identity from the caller's token rather than from the request body
// is what stops one user spending another's credits.

import { createClient } from '@supabase/supabase-js';
import { Ledger } from '../_shared/ledger.ts';
import { runOperation } from '../_shared/gateway.ts';
import { providers } from '../_shared/providers.ts';
import { GatewayError } from '../_shared/types.ts';
import type { GatewayRequest } from '../_shared/types.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  // Who is asking — established from their token, never from the body.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: auth, error: authError } = await caller.auth.getUser();
  if (authError || !auth?.user) return json({ error: 'unauthorized' }, 401);

  let payload: GatewayRequest;
  try {
    payload = (await request.json()) as GatewayRequest;
  } catch {
    return json({ error: 'invalid_request', message: 'Body must be JSON' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const result = await runOperation(
      {
        ledger: new Ledger(admin),
        providers,
        apiKeys: {
          openai: Deno.env.get('OPENAI_API_KEY'),
          anthropic: Deno.env.get('ANTHROPIC_API_KEY'),
        },
      },
      auth.user.id,
      payload
    );

    return json(result);
  } catch (error) {
    if (error instanceof GatewayError) {
      return json({ error: error.code, message: error.message }, error.status);
    }

    // Don't leak internals to a client; the detail is in the function logs.
    console.error('ai-gateway failure', error);
    return json({ error: 'internal_error' }, 500);
  }
});
