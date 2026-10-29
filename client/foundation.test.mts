// App Foundation — client behaviour, against a stubbed transport.
//
// The integration test in client/live.test.mts proves the contract is right.
// This file proves the client is right about the things a live test cannot
// reliably provoke: a dropped connection mid-call, two screens racing on a
// cold start, an expired token, a revoked refresh token.
//
// The money-critical property is that a retry reuses its requestId. That is
// what makes a retried call reuse its original credit hold instead of taking
// a second one, so a flaky network cannot charge a user twice.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFoundation, FoundationError } from './foundation.ts';

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown };

/** Records every call, and answers from a queue of per-path handlers. */
function stub() {
  const calls: { url: string; body: any }[] = [];
  const handlers: Handler[] = [];

  const fetchLike = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });

    const handler = handlers.shift();
    const { status, body: out } = handler
      ? handler(String(url), init)
      : { status: 500, body: { error: 'internal_error', message: 'no handler queued' } };

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out,
      text: async () => JSON.stringify(out),
    } as unknown as Response;
  };

  return {
    fetch: fetchLike as unknown as typeof fetch,
    calls,
    queue: (...hs: Handler[]) => handlers.push(...hs),
    of: (fragment: string) => calls.filter((c) => c.url.includes(fragment)),
  };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const session = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    user: { id: 'user-1', is_anonymous: true },
    ...over,
  },
});

const ok = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { text: 'tagged', operation: 'app.op', creditsCharged: 3, balance: { free: 7, paid: 0 }, ...over },
});

const fail = (status: number, error: string) => ({ status, body: { error, message: error } });

let net: ReturnType<typeof stub>;
let store: ReturnType<typeof memoryStorage>;

function client(opts: Record<string, unknown> = {}) {
  return createFoundation({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    storage: store,
    fetch: net.fetch,
    sleep: async () => {}, // no real backoff in tests
    ...opts,
  });
}

beforeEach(() => {
  net = stub();
  store = memoryStorage();
});

describe('signing in', () => {
  it('signs in anonymously on first use', async () => {
    net.queue(() => session());
    const f = client();

    assert.equal(await f.userId(), 'user-1');
    assert.equal(net.of('/auth/v1/signup').length, 1);
  });

  it('signs in once when several calls race on a cold start', async () => {
    // Two screens calling run() at launch both find no session. Without
    // single-flighting this creates two anonymous users and silently strands
    // whichever one loses — along with anything it had been granted.
    net.queue(() => session(), () => ok(), () => ok());
    const f = client();

    await Promise.all([f.run('app.op', { text: 'a' }), f.run('app.op', { text: 'b' })]);

    assert.equal(net.of('/auth/v1/signup').length, 1, 'exactly one anonymous user');
    assert.equal(net.of('ai-gateway').length, 2);
  });

  it('reuses a stored session on the next launch', async () => {
    store = memoryStorage({
      'foundation.session.v1': JSON.stringify({
        accessToken: 'stored', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
        userId: 'user-stored', isAnonymous: true,
      }),
    });
    net.queue(() => ok());

    const f = client();
    await f.run('app.op', { text: 'x' });

    assert.equal(net.of('/auth/v1').length, 0, 'no sign-in or refresh needed');
    const [call] = net.of('ai-gateway');
    assert.ok(call, 'the call happened');
  });

  it('refreshes a session that is about to expire', async () => {
    store = memoryStorage({
      'foundation.session.v1': JSON.stringify({
        accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 5_000,
        userId: 'user-1', isAnonymous: true,
      }),
    });
    net.queue(() => session({ access_token: 'fresh' }), () => ok());

    await client().run('app.op', { text: 'x' });

    assert.equal(net.of('grant_type=refresh_token').length, 1);
    assert.equal(net.of('/auth/v1/signup').length, 0, 'refresh, not a brand new user');
  });

  it('falls back to a new anonymous user only when the refresh token is rejected', async () => {
    store = memoryStorage({
      'foundation.session.v1': JSON.stringify({
        accessToken: 'old', refreshToken: 'revoked', expiresAt: Date.now() - 1,
        userId: 'user-old', isAnonymous: true,
      }),
    });
    net.queue(() => fail(400, 'invalid_grant'), () => session({ user: { id: 'user-new', is_anonymous: true } }), () => ok());

    const f = client();
    assert.equal(await f.userId(), 'user-new');
  });

  it('survives storage it cannot read', async () => {
    store = { getItem: () => { throw new Error('keychain locked'); },
              setItem: () => {}, removeItem: () => {} } as any;
    net.queue(() => session());

    assert.equal(await client().userId(), 'user-1', 'a bad store costs a new user, not a crash');
  });

  it('still works when the session cannot be persisted', async () => {
    store = { getItem: () => null,
              setItem: () => { throw new Error('disk full'); },
              removeItem: () => {} } as any;
    net.queue(() => session(), () => ok());

    const result = await client().run('app.op', { text: 'x' });
    assert.equal(result.creditsCharged, 3);
  });
});

describe('running an operation', () => {
  it('sends operation, input and a requestId, never a model', async () => {
    net.queue(() => session(), () => ok());
    await client().run('app.op', { text: 'hello' });

    const [{ body }] = net.of('ai-gateway');
    assert.equal(body.operation, 'app.op');
    assert.deepEqual(body.input, { text: 'hello' });
    assert.ok(body.requestId, 'a requestId is always sent');
    assert.ok(!('model' in body), 'a client must never name a model');
  });

  it('reuses the same requestId across retries — the double-charge guard', async () => {
    net.queue(() => session(), () => fail(502, 'provider_error'), () => ok());
    await client().run('app.op', { text: 'x' });

    const ids = net.of('ai-gateway').map((c) => c.body.requestId);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1], 'a fresh id per retry would take a second credit hold');
  });

  it('honours a caller-supplied requestId, so a resumed job keeps its hold', async () => {
    net.queue(() => session(), () => ok());
    await client().run('app.op', { text: 'x' }, { requestId: 'job-42' });

    assert.equal(net.of('ai-gateway')[0].body.requestId, 'job-42');
  });

  it('gives up after maxRetries and reports the real failure', async () => {
    net.queue(() => session(), () => fail(504, 'timeout'), () => fail(504, 'timeout'), () => fail(504, 'timeout'));

    await assert.rejects(
      () => client({ maxRetries: 2 }).run('app.op', { text: 'x' }),
      (e: FoundationError) => e.code === 'timeout' && e.retryable
    );
    assert.equal(net.of('ai-gateway').length, 3, 'initial attempt plus two retries');
  });

  it('does not retry an insufficient balance', async () => {
    net.queue(() => session(), () => fail(402, 'insufficient_credits'));

    await assert.rejects(
      () => client().run('app.op', { text: 'x' }),
      (e: FoundationError) => e.code === 'insufficient_credits' && !e.retryable
    );
    assert.equal(net.of('ai-gateway').length, 1, 'retrying would just fail again');
  });

  it('does not retry an unknown operation', async () => {
    net.queue(() => session(), () => fail(400, 'unknown_operation'));

    await assert.rejects(
      () => client().run('nope', { text: 'x' }),
      (e: FoundationError) => e.code === 'unknown_operation' && !e.retryable
    );
    assert.equal(net.of('ai-gateway').length, 1);
  });

  it('refreshes once on a 401, then retries', async () => {
    net.queue(() => session(), () => fail(401, 'unauthorized'), () => session({ access_token: 'fresh' }), () => ok());

    const result = await client().run('app.op', { text: 'x' });
    assert.equal(result.creditsCharged, 3);
    assert.equal(net.of('grant_type=refresh_token').length, 1);
  });

  it('gives up if a freshly refreshed token is also rejected', async () => {
    // A second 401 after a new token is a real rejection, not a stale one —
    // looping on it would hammer the auth endpoint forever.
    net.queue(
      () => session(), () => fail(401, 'unauthorized'),
      () => session({ access_token: 'fresh' }), () => fail(401, 'unauthorized')
    );

    await assert.rejects(
      () => client().run('app.op', { text: 'x' }),
      (e: FoundationError) => e.code === 'unauthorized'
    );
    assert.equal(net.of('grant_type=refresh_token').length, 1, 'refreshed exactly once');
  });

  it('turns a dead network into a typed, retryable error', async () => {
    net.queue(() => session());
    const f = createFoundation({
      url: 'https://example.supabase.co', anonKey: 'k', storage: store,
      sleep: async () => {}, maxRetries: 0,
      fetch: (async (u: string) =>
        String(u).includes('/auth/')
          ? ({ ok: true, status: 200, text: async () => JSON.stringify(session().body),
               json: async () => session().body } as unknown as Response)
          : Promise.reject(new TypeError('Network request failed'))) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => f.run('app.op', { text: 'x' }),
      (e: FoundationError) => e.code === 'network_error' && e.retryable
    );
  });

  it('parses a structured result, and flags output that is not JSON', async () => {
    net.queue(() => session(), () => ok({ text: '{"name":"Shirt","formality":3}' }));
    const parsed = await client().runJson<{ name: string }>('app.op', { text: 'x' });
    assert.equal(parsed.name, 'Shirt');

    net = stub();
    store = memoryStorage();
    net.queue(() => session(), () => ok({ text: 'not json at all' }));
    await assert.rejects(
      () => client().runJson('app.op', { text: 'x' }),
      // The credits are already spent — worth distinguishing from a failed call.
      (e: FoundationError) => e.code === 'bad_response' && /not JSON/.test(e.message)
    );
  });
});

describe('reading a balance', () => {
  it('reads the caller’s own row', async () => {
    net.queue(() => session(), () => ({ status: 200, body: [{ free: 22, paid: 5 }] }));
    assert.deepEqual(await client().balance(), { free: 22, paid: 5 });

    assert.ok(net.of('credit_balances')[0].url.includes('user_id=eq.user-1'));
  });

  it('treats no row as a zero balance, not an error', async () => {
    // RLS also returns [] for somebody else's row, so an empty result never
    // means "forbidden" — and a brand new user simply has no row yet.
    net.queue(() => session(), () => ({ status: 200, body: [] }));
    assert.deepEqual(await client().balance(), { free: 0, paid: 0 });
  });
});

describe('signing out', () => {
  it('forgets the session, which for an anonymous user is irreversible', async () => {
    net.queue(() => session(), () => session({ user: { id: 'user-2', is_anonymous: true } }));
    const f = client();

    assert.equal(await f.userId(), 'user-1');
    await f.signOut();
    assert.equal(store.map.size, 0, 'nothing left behind');
    assert.equal(await f.userId(), 'user-2', 'the old anonymous user is unreachable');
  });
});

describe('portability', () => {
  it('generates a request id without crypto.randomUUID', () => {
    // React Native has no crypto.randomUUID — Expo's runtime installs much of
    // the web standard library but not that. Calling it passed every test in
    // Node and threw on the first real phone.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

    try {
      net.queue(() => session(), () => ok());
      const f = client();
      return f.run('app.op', { text: 'x' }).then(() => {
        const id = net.of('ai-gateway')[0].body.requestId;
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      });
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });

  it('produces distinct ids even on the Math.random fallback', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

    try {
      const ids = new Set<string>();

      for (let i = 0; i < 300; i++) {
        net = stub();
        store = memoryStorage();
        net.queue(() => session(), () => ok());
        await client().run('app.op', { text: 'x' });
        ids.add(net.of('ai-gateway')[0].body.requestId);
      }

      // A collision here would be two requests sharing a credit hold, so the
      // second one would run for free against the first one's reservation.
      assert.equal(ids.size, 300, 'every request id must be distinct');
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
