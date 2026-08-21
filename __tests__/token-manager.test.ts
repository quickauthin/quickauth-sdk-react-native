import { __resetConfig, setConfig } from '../src/core/config';
import {
  TokenManager,
  __resetTokenManager,
  getTokenExpiryMs,
  request,
} from '../src/core/client';

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number, sub = 'tok'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const FUTURE = () => Math.floor(Date.now() / 1000) + 600; // 10 min ahead
const PAST = () => Math.floor(Date.now() / 1000) - 60; // already expired

describe('core/client — TokenManager', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    global.fetch = jest.fn();
  });

  it('getTokenExpiryMs decodes a real JWT exp', () => {
    const tok = makeJwt(FUTURE());
    const ms = getTokenExpiryMs(tok);
    expect(ms).toBeGreaterThan(Date.now());
    expect(getTokenExpiryMs('not.a.jwt')).toBeNull();
    expect(getTokenExpiryMs('')).toBeNull();
  });

  it('invokes onTokenExpiry when no token cached', async () => {
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });
    setConfig({ onTokenExpiry: provider });

    const tok = await tm.getToken();
    expect(tok).toMatch(/^eyJ/);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh token across calls', async () => {
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    setConfig({ onTokenExpiry: provider });
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });

    await tm.getToken();
    await tm.getToken();
    await tm.getToken();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('refreshes when token is within 30s of expiry', async () => {
    const expiringSoon = makeJwt(Math.floor(Date.now() / 1000) + 5); // 5s left
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    setConfig({ onTokenExpiry: provider });
    const tm = new TokenManager({ initialToken: expiringSoon, mintUnsafeToken: async () => 'x' });

    await tm.getToken();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('single-flight: concurrent getToken calls share one provider invocation', async () => {
    let resolveProvider: ((tok: string) => void) | null = null;
    const provider = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveProvider = resolve;
        })
    );
    setConfig({ onTokenExpiry: provider });
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });

    const promises = Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    // Provider has been called exactly once even though 3 callers waited.
    expect(provider).toHaveBeenCalledTimes(1);
    resolveProvider!(makeJwt(FUTURE()));
    const tokens = await promises;
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[1]).toBe(tokens[2]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next getToken to refresh', async () => {
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    setConfig({ onTokenExpiry: provider });
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });

    await tm.getToken();
    expect(provider).toHaveBeenCalledTimes(1);
    tm.invalidate();
    await tm.getToken();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('throws if onTokenExpiry returns invalid token', async () => {
    setConfig({ onTokenExpiry: async () => '' });
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });
    await expect(tm.getToken()).rejects.toThrow(/invalid token/);
  });

  it('refreshes immediately when initialToken is already expired', async () => {
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    setConfig({ onTokenExpiry: provider });
    const tm = new TokenManager({ initialToken: makeJwt(PAST()), mintUnsafeToken: async () => 'x' });
    await tm.getToken();
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('core/client — request() bearer auth', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    global.fetch = jest.fn();
  });

  it('attaches Authorization: Bearer on every POST', async () => {
    const tok = makeJwt(FUTURE());
    setConfig({ onTokenExpiry: async () => tok });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    });

    await request({ method: 'POST', path: '/v1/test/a', body: {} });
    await request({ method: 'POST', path: '/v1/test/b', body: {} });

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    for (const [, opts] of calls) {
      expect(opts.headers.Authorization).toBe(`Bearer ${tok}`);
    }
  });

  it('on 401: invalidates token, refreshes, retries once', async () => {
    let n = 0;
    const provider = jest.fn(async () => {
      n += 1;
      return makeJwt(FUTURE(), `tok${n}`);
    });
    setConfig({ onTokenExpiry: provider });

    // The retry mutates one shared headers object, so Authorization has to be
    // snapshotted per call rather than read off mock.calls afterwards.
    const auths: string[] = [];
    const bodies = [
      { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"expired"}' },
      { ok: true, status: 200, statusText: 'OK', text: async () => '{"ok":true}' },
    ];
    let call = 0;
    global.fetch = jest.fn(async (_url: string, opts: { headers: Record<string, string> }) => {
      auths.push(opts.headers.Authorization!);
      return bodies[Math.min(call++, bodies.length - 1)];
    }) as unknown as jest.Mock;

    const out = await request<{ ok: boolean }>({ method: 'POST', path: '/v1/test', body: {} });
    expect(out.ok).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it('does not infinitely loop on persistent 401', async () => {
    const provider = jest.fn(async () => makeJwt(FUTURE()));
    setConfig({ onTokenExpiry: provider });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{}',
    });

    await expect(request({ method: 'POST', path: '/v1/test', body: {} })).rejects.toThrow(/HTTP 401/);
    // First request + one retry after 401 = 2 fetches max.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
  });
});

describe('core/client — unsafe mode', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    global.fetch = jest.fn();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns on init and mints sessionToken via /v1/sdk/session with X-Client-* headers', async () => {
    setConfig({
      unsafe: { clientId: 'cid_abc', clientSecret: 'csec_xyz' },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNSAFE mode')
    );

    const tok = makeJwt(FUTURE());
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ sessionToken: tok }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{"ok":true}',
      });

    await request({ method: 'POST', path: '/v1/test', body: {} });

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);

    const [sessionUrl, sessionOpts] = calls[0];
    expect(sessionUrl).toBe('https://api.quickauth.in/v1/sdk/session');
    expect(sessionOpts.method).toBe('POST');
    expect(sessionOpts.headers['X-Client-Id']).toBe('cid_abc');
    expect(sessionOpts.headers['X-Client-Secret']).toBe('csec_xyz');

    const [, apiOpts] = calls[1];
    expect(apiOpts.headers.Authorization).toBe(`Bearer ${tok}`);
  });

  it('suppresses warn when silent=true', () => {
    setConfig({
      unsafe: { clientId: 'cid', clientSecret: 'csec' },
      silent: true,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('core/config validation', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
  });

  it('throws if no onTokenExpiry, no unsafe, no initialToken', () => {
    expect(() => setConfig({})).toThrow(/onTokenExpiry/);
  });

  it('accepts initialToken alone', () => {
    expect(() => setConfig({ initialToken: makeJwt(FUTURE()) })).not.toThrow();
  });

  it('accepts onTokenExpiry alone', () => {
    expect(() => setConfig({ onTokenExpiry: async () => 'x' })).not.toThrow();
  });
});
