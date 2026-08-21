import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager, request } from '../src/core/client';

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number, sub = 'sess'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const freshJwt = (): string => makeJwt(Math.floor(Date.now() / 1000) + 600);

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
  };
}

/**
 * `request()` mutates one shared headers object across attempts, so reading
 * `fetch.mock.calls[i][1].headers` after the fact would show every attempt the
 * final values. Snapshot each attempt's headers at call time instead.
 */
let sentHeaders: Array<Record<string, string>>;

function mockFetchSequence(...responses: ReturnType<typeof res>[]): void {
  let i = 0;
  global.fetch = jest.fn(async (_url: string, opts: { headers: Record<string, string> }) => {
    sentHeaders.push({ ...opts.headers });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  }) as unknown as jest.Mock;
}

describe('client — 429 is not retried (rate-limit amplification)', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    sentHeaders = [];
    setConfig({ onTokenExpiry: async () => freshJwt(), maxRetries: 2 });
  });

  it('fails fast on 429 instead of backing off into the limit', async () => {
    mockFetchSequence(res(429, { error: 'rate_limited' }));

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).rejects.toMatchObject({ status: 429 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('still retries 408 and 5xx', async () => {
    mockFetchSequence(res(408), res(200, { ok: true }));
    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    global.fetch.mockClear();
    mockFetchSequence(res(503), res(200, { ok: true }));
    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 15_000);
});

describe('client — 401 refresh replays the same request', () => {
  let provider: jest.Mock;

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    sentHeaders = [];
    provider = jest.fn(async () => freshJwt());
    setConfig({ onTokenExpiry: provider, maxRetries: 0 });
  });

  it('reuses the original Idempotency-Key so a retried OTP send dedupes', async () => {
    mockFetchSequence(res(401), res(200, { ok: true }));

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: { phone: '+91' } })
    ).resolves.toEqual({ ok: true });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders[0]!['Idempotency-Key']).toBeTruthy();
    expect(sentHeaders[1]!['Idempotency-Key']).toBe(sentHeaders[0]!['Idempotency-Key']);
  });

  it('replays with a freshly minted token', async () => {
    mockFetchSequence(res(401), res(200, { ok: true }));
    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });

    expect(provider).toHaveBeenCalledTimes(2); // initial mint + post-401 refresh
    expect(sentHeaders[1]!.Authorization).toMatch(/^Bearer eyJ/);
  });

  it('refreshes at most once — a second 401 fails', async () => {
    mockFetchSequence(res(401), res(401));

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).rejects.toMatchObject({ status: 401 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not hand the request a fresh retry budget', async () => {
    // maxRetries 1 => 2 attempts total. The 401 replay must not reset that
    // count, so the sequence is 500 (attempt 0), 401 (attempt 1), 500 (replay
    // of attempt 1) and then it is out of budget: 3 calls, not 4.
    setConfig({ onTokenExpiry: provider, maxRetries: 1 });
    mockFetchSequence(res(500), res(401), res(500));

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).rejects.toMatchObject({ status: 500 });

    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('surfaces the 401 when the token provider itself fails', async () => {
    provider
      .mockImplementationOnce(async () => freshJwt())
      .mockImplementationOnce(async () => {
        throw new Error('customer backend down');
      });
    mockFetchSequence(res(401));

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).rejects.toMatchObject({ status: 401 });
  });
});
