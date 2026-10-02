// Cases mirrored from the Web and Flutter suites, named to match.

import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager, getTokenExpiryMs, TokenManager } from '../src/core/client';
import {
  initiate,
  submitOtp,
  reset,
  openWhatsApp,
  startWhatsAppLogin,
  __resetSession,
} from '../src/auth/otp';
import { readCode } from '../src/auth/native-module';
import * as consent from '../src/core/consent';
import { __resetStorage, createMemoryStorage, setStorageAdapter } from '../src/core/storage';
import type { AuthEvent } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function reply(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => JSON.stringify(body),
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const sent = { state: 'OTP_SENT', sessionId: 's_1', expiresIn: 300 };

describe('OTP flow — Web / Flutter parity', () => {
  let events: AuthEvent[];
  let store: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    consent.__reset();
    store = createMemoryStorage();
    setStorageAdapter(store);
    events = [];
    setConfig({
      publishableKey: 'pk_test_abc',
      maxRetries: 0,
      onAuthEvent: (e) => events.push(e),
    });
    RN.__testHelpers.setPlatform('android');
    global.fetch = jest.fn();
  });

  it('[web] throws when called before init', async () => {
    __resetConfig();
    await expect(initiate({ phone: '+919876543210' })).rejects.toThrow(/not initialised/);
  });

  it('[web] suppresses events from a superseded attempt', async () => {
    let releaseFirst!: (v: unknown) => void;
    global.fetch
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockResolvedValueOnce(reply({ ...sent, sessionId: 's_second' }));

    const first = initiate({ phone: '+919876543210' });
    await flush();
    await initiate({ phone: '+919876543211' }); // supersedes the first
    releaseFirst(reply({ ...sent, sessionId: 's_first' }));
    await first;
    await flush();

    const sentEvents = events.filter((e) => e.type === 'OTP_SENT');
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({ sessionId: 's_second' });
  });

  it('[web] does not break the SDK when the handler throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    setConfig({
      publishableKey: 'pk_test_abc',
      onAuthEvent: () => {
        throw new Error('merchant bug');
      },
    });
    global.fetch
      .mockResolvedValueOnce(reply(sent))
      .mockResolvedValueOnce(reply({ state: 'VERIFIED', verified: true, requestId: 'r_1' }));

    await initiate({ phone: '+919876543210' });
    await flush();
    await expect(submitOtp('123456')).resolves.toBeUndefined();
    await flush();
    expect(errorSpy).toHaveBeenCalledWith('[QuickAuth] onAuthEvent handler threw:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('[web] keeps the device token when forgetDevice is false/omitted', async () => {
    global.fetch.mockResolvedValueOnce(reply({ ...sent, deviceToken: 'dtok_1' }));
    await initiate({ phone: '+919876543210' });
    await reset();
    await reset({ forgetDevice: false });

    global.fetch.mockResolvedValueOnce(reply(sent));
    await initiate({ phone: '+919876543210' });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).deviceToken).toBe('dtok_1');
  });

  it('[web] blocks submitOtp after reset', async () => {
    global.fetch.mockResolvedValueOnce(reply(sent));
    await initiate({ phone: '+919876543210' });
    await reset();
    await expect(submitOtp('123456')).rejects.toThrow(/state "idle"/);
  });

  it('[flutter] omits deviceInfo when consent has not been granted', async () => {
    global.fetch.mockResolvedValueOnce(reply(sent));
    await initiate({ phone: '+919876543210' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).deviceInfo).toBeUndefined();
  });

  it('[flutter] verify also carries deviceInfo once consent is granted', async () => {
    await consent.set(true);
    global.fetch
      .mockResolvedValueOnce(reply(sent))
      .mockResolvedValueOnce(reply({ state: 'VERIFIED', verified: true, requestId: 'r_1' }));
    await initiate({ phone: '+919876543210' });
    await submitOtp('123456');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).deviceInfo).toMatchObject({
      platform: 'android',
    });
  });

  it('OTP_SENT defaults expiresIn to 300 when the backend omits it (as Flutter does)', async () => {
    global.fetch.mockResolvedValueOnce(reply({ state: 'OTP_SENT', sessionId: 's_1' }));
    await initiate({ phone: '+919876543210' });
    await flush();
    expect(events[0]).toMatchObject({ type: 'OTP_SENT', expiresIn: 300 });
  });

  it('[web] builds a wa.me URL with the business number', async () => {
    await expect(
      openWhatsApp({ businessNumber: '+91 98765-43210', message: 'Hi, log me in' })
    ).resolves.toBe(true);
    expect(RN.Linking.openURL).toHaveBeenCalledWith('https://wa.me/919876543210?text=Hi%2C%20log%20me%20in');
  });

  it('startWhatsAppLogin rejects when WhatsApp cannot be opened', async () => {
    RN.Linking.canOpenURL.mockResolvedValueOnce(false);
    await expect(startWhatsAppLogin({ businessNumber: '919876543210' })).rejects.toThrow(
      /WhatsApp not installed/
    );
  });

  it('openWhatsApp rejects an empty business number', async () => {
    await expect(openWhatsApp({ businessNumber: '+-' })).rejects.toThrow(/businessNumber required/);
  });
});

describe('WhatsApp code normalisation — Flutter whatsapp_otp_retriever_test parity', () => {
  it('trims, because a padded code fails verification for no visible reason', () => {
    expect(readCode(' 123456 ')).toBe('123456');
    expect(readCode({ code: '\n654321\t' })).toBe('654321');
  });

  it('ignores empty broadcasts rather than surfacing a blank code', () => {
    expect(readCode('')).toBeNull();
    expect(readCode('   ')).toBeNull();
    expect(readCode({})).toBeNull();
    expect(readCode(null)).toBeNull();
    expect(readCode(undefined)).toBeNull();
  });
});

describe('consent — Flutter consent_test parity', () => {
  beforeEach(() => {
    consent.__reset();
    __resetStorage();
    setStorageAdapter(createMemoryStorage());
  });

  it('replays queued events on grant in original order', async () => {
    const order: number[] = [];
    await consent.run(async () => void order.push(1));
    await consent.run(async () => void order.push(2));
    await consent.run(async () => void order.push(3));
    expect(order).toEqual([]);
    await consent.set(true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs immediately while granted', async () => {
    await consent.set(true);
    const ran = jest.fn(async () => undefined);
    await consent.run(ran);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(consent.pendingCount()).toBe(0);
  });

  it('a queued runner that throws does not stop the rest', async () => {
    const ran = jest.fn(async () => undefined);
    await consent.run(async () => {
      throw new Error('boom');
    });
    await consent.run(ran);
    await consent.set(true);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('token manager — Web / Flutter parity', () => {
  it('[web] returns null on malformed JWTs', () => {
    expect(getTokenExpiryMs('not-a-jwt')).toBeNull();
    expect(getTokenExpiryMs('a.b.c')).toBeNull();
    expect(getTokenExpiryMs('')).toBeNull();
  });

  it('[flutter] a malformed JWT is used, not refreshed on every call', async () => {
    const mint = jest.fn(async () => 'opaque-token');
    __resetConfig();
    setConfig({ onTokenExpiry: mint });
    const tm = new TokenManager({ initialToken: null, mintUnsafeToken: async () => 'x' });
    expect(await tm.getToken()).toBe('opaque-token');
    expect(await tm.getToken()).toBe('opaque-token');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('[web] decodes the exp claim from a well-formed JWT', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(getTokenExpiryMs(makeJwt(exp))).toBe(exp * 1000);
  });
});

describe('device token cache', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    RN.__testHelpers.setPlatform('android');
  });

  it('initiate() before init() fails before any side effect', async () => {
    const store = createMemoryStorage();
    await store.setItem('qa_device_token', 'dtok_stale');
    const spy = jest.spyOn(store, 'getItem');
    setStorageAdapter(store);
    const native = RN.NativeModules.QuickAuthSmsRetriever;
    native.start.mockClear();
    native.sendWhatsAppOtpHandshake.mockClear();

    await expect(initiate({ phone: '+919876543210' })).rejects.toThrow(/not initialised/);
    expect(spy).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(native.sendWhatsAppOtpHandshake).not.toHaveBeenCalled();
  });

  it('init() re-reads the device token instead of reusing a stale cached one', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const QuickAuth = require('../src').default;
    const store = createMemoryStorage();
    global.fetch = jest.fn().mockResolvedValue(reply({ ...sent, deviceToken: 'dtok_1' }));
    await QuickAuth.init({ publishableKey: 'pk_test_abc', storage: store });
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    expect(await store.getItem('qa_device_token')).toBe('dtok_1');

    // Storage cleared externally (user cleared data, sign-out elsewhere).
    await store.removeItem('qa_device_token');
    await QuickAuth.reset();
    await QuickAuth.init({ publishableKey: 'pk_test_abc', storage: store });
    global.fetch.mockClear();
    await QuickAuth.auth.initiate({ phone: '+919876543210' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).deviceToken).toBeUndefined();
  });
});
