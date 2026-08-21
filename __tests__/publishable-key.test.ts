import { __resetConfig, getConfig, setConfig } from '../src/core/config';
import { __resetTokenManager, request } from '../src/core/client';
import { __resetAppIdentity } from '../src/core/app-identity';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

const okResponse = {
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => '{}',
};

function lastHeaders(): Record<string, string> {
  const calls = global.fetch.mock.calls;
  return calls[calls.length - 1][1].headers as Record<string, string>;
}

describe('config — publishable-key mode selection', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetAppIdentity();
  });

  it('accepts publishableKey alone and reports publishable-key mode', () => {
    const cfg = setConfig({ publishableKey: 'pk_test_abc' });
    expect(cfg.isPublishableKeyMode).toBe(true);
    expect(cfg.publishableKey).toBe('pk_test_abc');
    expect(cfg.onTokenExpiry).toBeNull();
  });

  it('keeps the session-token mode working and reports non-publishable mode', () => {
    const cfg = setConfig({ onTokenExpiry: async () => 'tok' });
    expect(cfg.isPublishableKeyMode).toBe(false);
    expect(cfg.publishableKey).toBeNull();
    expect(cfg.onTokenExpiry).not.toBeNull();
  });

  it('treats an empty publishableKey as not supplied', () => {
    expect(() => setConfig({ publishableKey: '' })).toThrow(/requires an auth mode/);
    const cfg = setConfig({ publishableKey: '', onTokenExpiry: async () => 'tok' });
    expect(cfg.isPublishableKeyMode).toBe(false);
  });

  it('rejects neither mode', () => {
    expect(() => setConfig({})).toThrow(/requires an auth mode/);
  });

  it('rejects both modes at once', () => {
    expect(() =>
      setConfig({ publishableKey: 'pk_test_abc', onTokenExpiry: async () => 'tok' })
    ).toThrow(/not both/);
  });
});

describe('client — publishable-key request headers', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetAppIdentity();
    RN.__testHelpers.setPlatform('android');
    RN.NativeModules.QuickAuthSmsRetriever.getAppIdentity = jest
      .fn()
      .mockResolvedValue('com.example.quickauthdemo');
    global.fetch = jest.fn().mockResolvedValue(okResponse);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('sends X-QuickAuth-Key and no Authorization header', async () => {
    setConfig({ publishableKey: 'pk_live_xyz' });
    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });

    const headers = lastHeaders();
    expect(headers['X-QuickAuth-Key']).toBe('pk_live_xyz');
    expect(headers.Authorization).toBeUndefined();
  });

  it('never consults the token manager in publishable-key mode', async () => {
    const provider = jest.fn(async () => 'should-never-be-called');
    setConfig({ publishableKey: 'pk_live_xyz' });
    // Simulate a stray token provider left on the resolved config: the request
    // path must not reach for a token even if one could be minted.
    (getConfig() as { onTokenExpiry: unknown }).onTokenExpiry = provider;

    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });
    expect(provider).not.toHaveBeenCalled();
  });

  it('sends X-QuickAuth-Package on Android', async () => {
    RN.__testHelpers.setPlatform('android');
    setConfig({ publishableKey: 'pk_live_xyz' });
    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });

    const headers = lastHeaders();
    expect(headers['X-QuickAuth-Package']).toBe('com.example.quickauthdemo');
    expect(headers['X-QuickAuth-Bundle']).toBeUndefined();
  });

  it('sends X-QuickAuth-Bundle on iOS', async () => {
    RN.__testHelpers.setPlatform('ios');
    setConfig({ publishableKey: 'pk_live_xyz' });
    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });

    const headers = lastHeaders();
    expect(headers['X-QuickAuth-Bundle']).toBe('com.example.quickauthdemo');
    expect(headers['X-QuickAuth-Package']).toBeUndefined();
  });

  it('omits the identity header and still sends when the native call throws', async () => {
    RN.NativeModules.QuickAuthSmsRetriever.getAppIdentity = jest.fn(() => {
      throw new Error('native module blew up');
    });
    setConfig({ publishableKey: 'pk_live_xyz' });

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).resolves.toBeDefined();

    const headers = lastHeaders();
    expect(headers['X-QuickAuth-Package']).toBeUndefined();
    expect(headers['X-QuickAuth-Key']).toBe('pk_live_xyz');
  });

  it('omits the identity header when the native call rejects', async () => {
    RN.NativeModules.QuickAuthSmsRetriever.getAppIdentity = jest
      .fn()
      .mockRejectedValue(new Error('bridge unavailable'));
    setConfig({ publishableKey: 'pk_live_xyz' });

    await expect(
      request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} })
    ).resolves.toBeDefined();
    expect(lastHeaders()['X-QuickAuth-Package']).toBeUndefined();
  });

  it('omits the identity header when the native module is absent', async () => {
    const saved = RN.NativeModules.QuickAuthSmsRetriever;
    delete RN.NativeModules.QuickAuthSmsRetriever;
    try {
      setConfig({ publishableKey: 'pk_live_xyz' });
      await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });
      expect(lastHeaders()['X-QuickAuth-Package']).toBeUndefined();
    } finally {
      RN.NativeModules.QuickAuthSmsRetriever = saved;
    }
  });

  it('still sends Authorization (and no key header) in session-token mode', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })
    ).toString('base64url');
    setConfig({ onTokenExpiry: async () => `${header}.${payload}.sig` });

    await request({ method: 'POST', path: '/v1/sdk/auth/initiate', body: {} });
    const headers = lastHeaders();
    expect(headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(headers['X-QuickAuth-Key']).toBeUndefined();
  });
});
