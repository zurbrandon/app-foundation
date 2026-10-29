// App Foundation — TypeScript client.
//
// A thin cover over docs/http-api.md. Deliberately dependency-free and plain
// `fetch`: it keeps ~100KB of supabase-js out of apps that only need four
// endpoints, and it keeps this file readable enough to port to Swift for
// Understory, which cannot use any of it.
//
// Nothing here is required to talk to the foundation. If this file and the
// contract ever disagree, the contract is right.

export type FoundationStorage = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
};

export type Session = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  userId: string;
  isAnonymous: boolean;
};

export type Balance = { free: number; paid: number };

export type RunInput = {
  system?: string;
  text?: string;
  image?: { base64: string; mediaType: string };
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

export type RunResult = {
  text: string;
  operation: string;
  creditsCharged: number;
  balance: Balance;
};

export type FoundationErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unknown_operation'
  | 'operation_disabled'
  | 'insufficient_credits'
  | 'provider_error'
  | 'timeout'
  | 'internal_error'
  | 'network_error'
  | 'bad_response';

/** Retrying these with the same requestId is safe and sometimes works. */
const RETRYABLE: ReadonlySet<FoundationErrorCode> = new Set([
  'provider_error',
  'timeout',
  'internal_error',
  'network_error',
]);

export class FoundationError extends Error {
  readonly code: FoundationErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: FoundationErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'FoundationError';
    this.code = code;
    this.status = status;
    this.retryable = RETRYABLE.has(code);
  }
}

export type FoundationOptions = {
  /** e.g. https://<ref>.supabase.co */
  url: string;
  /** The project's anon key. Public by design; it grants nothing on its own. */
  anonKey: string;
  /**
   * Where the session lives between launches. An anonymous user cannot sign
   * back in by any other means, so losing this loses the account and anything
   * it had. Use secure, non-backed-up-to-a-shared-place storage.
   */
  storage: FoundationStorage;
  /** Override for tests. */
  fetch?: typeof fetch;
  /** How many times to retry a retryable failure. Default 2. */
  maxRetries?: number;
  /** Override for tests; real delays make test suites slow. */
  sleep?: (ms: number) => Promise<void>;
};

const SESSION_KEY = 'foundation.session.v1';
/** Refresh this far ahead of expiry, to absorb clock skew and slow networks. */
const REFRESH_MARGIN_MS = 60_000;

export function createFoundation(options: FoundationOptions) {
  const http = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.url.replace(/\/+$/, '');
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let session: Session | null = null;
  let loaded = false;

  // Single-flight. Without these, two screens calling run() on a cold start
  // both find no session and both sign in anonymously — creating two users and
  // silently stranding whichever one loses. Same hazard on refresh, where the
  // loser's refresh token has already been invalidated by the winner.
  let pending: Promise<Session> | null = null;

  async function readStored(): Promise<Session | null> {
    try {
      const raw = await options.storage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      // Unreadable or corrupt: treat as no session rather than failing to
      // start. The cost is a new anonymous user, not a crash.
      return null;
    }
  }

  async function store(next: Session | null): Promise<void> {
    session = next;
    try {
      if (next) await options.storage.setItem(SESSION_KEY, JSON.stringify(next));
      else await options.storage.removeItem(SESSION_KEY);
    } catch {
      // A session we cannot persist still works for this launch.
    }
  }

  function toSession(body: Record<string, any>): Session {
    const user = body.user ?? {};
    if (!body.access_token || !body.refresh_token || !user.id) {
      throw new FoundationError('bad_response', 'Auth response was missing a session');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
      userId: user.id,
      isAnonymous: user.is_anonymous !== false,
    };
  }

  async function authPost(path: string, body: unknown): Promise<Record<string, any>> {
    let response: Response;
    try {
      response = await http(`${base}${path}`, {
        method: 'POST',
        headers: { apikey: options.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new FoundationError('network_error', `Could not reach ${path}`, 0);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new FoundationError('unauthorized', text.slice(0, 200) || 'Auth failed', response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new FoundationError('bad_response', 'Auth response was not JSON');
    }
  }

  const signInAnonymously = () => authPost('/auth/v1/signup', {}).then(toSession);

  const refresh = (token: string) =>
    authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: token }).then(toSession);

  const fresh = (s: Session | null): s is Session =>
    !!s && s.expiresAt - Date.now() >= REFRESH_MARGIN_MS;

  /** The current session, signing in or refreshing as needed. */
  function ensureSession(force = false): Promise<Session> {
    if (pending) return pending;
    if (!force && loaded && fresh(session)) return Promise.resolve(session);

    // Everything that can yield lives inside the promise, and `pending` is
    // assigned before control can leave this function. Reading storage before
    // assigning it meant two cold-start callers both got past the check above
    // and each signed in — creating two anonymous users and stranding
    // whichever one lost, along with anything it had been granted.
    pending = (async () => {
      try {
        if (!loaded) {
          session = await readStored();
          loaded = true;
        }

        if (!force && fresh(session)) return session;

        const next = session?.refreshToken
          ? await refresh(session.refreshToken).catch(async (error) => {
              // A refresh token can be revoked or already spent. Falling back
              // to a new anonymous user loses whatever the old one had, so it
              // is a last resort, not a retry.
              if (error instanceof FoundationError && error.status === 400) {
                return signInAnonymously();
              }
              throw error;
            })
          : await signInAnonymously();

        await store(next);
        return next;
      } finally {
        pending = null;
      }
    })();

    return pending;
  }

  async function call(path: string, init: RequestInit, token: string): Promise<Response> {
    try {
      return await http(`${base}${path}`, {
        ...init,
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new FoundationError('network_error', `Could not reach ${path}`, 0);
    }
  }

  async function errorFrom(response: Response): Promise<FoundationError> {
    let code: FoundationErrorCode = 'internal_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.error) code = body.error as FoundationErrorCode;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body: the status is all we have.
    }
    if (response.status === 401) code = 'unauthorized';
    return new FoundationError(code, message, response.status);
  }

  return {
    /** Signs in anonymously on first use. Safe to call concurrently. */
    session: () => ensureSession(),

    async userId(): Promise<string> {
      return (await ensureSession()).userId;
    },

    /** Whether this user still needs securing before they can be sold credits. */
    async isAnonymous(): Promise<boolean> {
      return (await ensureSession()).isAnonymous;
    },

    /**
     * Run an operation.
     *
     * `requestId` is generated once and reused across retries, which is what
     * makes a retry free: it keys the credit reservation, so a request retried
     * after a dropped connection reuses the original hold instead of taking a
     * second one. Passing a fresh id per attempt would risk charging twice.
     */
    async run(operation: string, input: RunInput, opts?: { requestId?: string }): Promise<RunResult> {
      const requestId = opts?.requestId ?? crypto.randomUUID();
      let refreshed = false;
      let lastError: FoundationError | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const { accessToken } = await ensureSession();

        const response = await call(
          '/functions/v1/ai-gateway',
          { method: 'POST', body: JSON.stringify({ operation, requestId, input }) },
          accessToken
        );

        if (response.ok) {
          try {
            return (await response.json()) as RunResult;
          } catch {
            throw new FoundationError('bad_response', 'Gateway returned malformed JSON');
          }
        }

        const error = await errorFrom(response);

        // One forced refresh, in case the token expired mid-flight. A second
        // 401 after a fresh token is a real rejection, not a stale one.
        if (error.code === 'unauthorized' && !refreshed) {
          refreshed = true;
          await ensureSession(true);
          attempt--;
          continue;
        }

        if (!error.retryable || attempt === maxRetries) throw error;

        lastError = error;
        await sleep(250 * 2 ** attempt);
      }

      throw lastError ?? new FoundationError('internal_error', 'Exhausted retries');
    },

    /** Run an operation whose input carried a jsonSchema, and parse the result. */
    async runJson<T>(operation: string, input: RunInput, opts?: { requestId?: string }): Promise<T> {
      const result = await this.run(operation, input, opts);
      try {
        return JSON.parse(result.text) as T;
      } catch {
        // The credits are already spent, so this is worth distinguishing from
        // a failed call: the operation ran, its output just wasn't usable.
        throw new FoundationError(
          'bad_response',
          `${operation} returned text that was not JSON`
        );
      }
    },

    /**
     * Current balance.
     *
     * Only needed on launch or after a purchase — `run` returns the new
     * balance with every successful call.
     */
    async balance(): Promise<Balance> {
      const { accessToken, userId } = await ensureSession();
      const response = await call(
        `/rest/v1/credit_balances?user_id=eq.${userId}&select=free,paid`,
        { method: 'GET' },
        accessToken
      );

      if (!response.ok) throw await errorFrom(response);

      const rows = (await response.json()) as Balance[];
      // No row yet is a zero balance, not an error. RLS also returns [] for
      // somebody else's row, so an empty result never means "forbidden".
      const row = rows[0];
      return { free: Number(row?.free ?? 0), paid: Number(row?.paid ?? 0) };
    },

    /** Forget the session. An anonymous user cannot be recovered afterwards. */
    async signOut(): Promise<void> {
      await store(null);
      loaded = true;
    },
  };
}

export type Foundation = ReturnType<typeof createFoundation>;
