/**
 * Storage is a declared dependency, not a nice-to-have.
 *
 * The device token is what OneTap is. When it lived in a `Map` because
 * AsyncStorage happened not to be installed, everything worked for the length
 * of a session and silently stopped working across a cold start — invisible in
 * development, expensive in production, and impossible to notice from the SDK's
 * own behaviour. `init()` now says so instead.
 *
 * This whole file runs with AsyncStorage unresolvable, which is the case under
 * test.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  throw new Error("Cannot find module '@react-native-async-storage/async-storage'");
});

import QuickAuth from '../src/index';
import { __resetConfig, isInitialised } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import {
  createMemoryStorage,
  getItem,
  hasStorage,
  requireStorage,
  setItem,
  __resetStorage,
} from '../src/core/storage';
import { initiate, __resetSession } from '../src/auth/otp';
import type { QuickAuthStorageAdapter } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const tokenProvider = async (): Promise<string> => makeJwt(Math.floor(Date.now() / 1000) + 600);

describe('core/storage — an explicit dependency', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    RN.__testHelpers.setPlatform('android');
    global.fetch = jest.fn();
  });

  it('init() fails loudly when there is no storage, naming every way to fix it', async () => {
    await expect(QuickAuth.init({ onTokenExpiry: tokenProvider })).rejects.toThrow(
      /persistent storage is unavailable/
    );
    const err = await QuickAuth.init({ onTokenExpiry: tokenProvider }).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toContain('@react-native-async-storage/async-storage');
    expect(message).toContain('init({ storage: myAdapter })');
    expect(message).toContain('createMemoryStorage()');
    // OneTap is the thing that breaks, so the message says so rather than
    // leaving the developer to work out why storage matters here.
    expect(message).toMatch(/OneTap/);
  });

  it('a failed init leaves the SDK uninitialised rather than half-configured', async () => {
    await QuickAuth.init({ onTokenExpiry: tokenProvider }).catch(() => undefined);
    expect(isInitialised()).toBe(false);
    expect(QuickAuth.isInitialized()).toBe(false);
  });

  it('accepts any adapter with the three async methods', async () => {
    await QuickAuth.init({ onTokenExpiry: tokenProvider, storage: createMemoryStorage() });
    expect(QuickAuth.isInitialized()).toBe(true);
    expect(hasStorage()).toBe(true);
  });

  it('rejects an adapter that is missing methods, rather than failing later on a write', async () => {
    const half = { getItem: async () => null } as unknown as QuickAuthStorageAdapter;
    await expect(
      QuickAuth.init({ onTokenExpiry: tokenProvider, storage: half })
    ).rejects.toThrow(/getItem\/setItem\/removeItem/);
  });

  it('never silently degrades to memory: reads throw when nothing is installed', async () => {
    expect(hasStorage()).toBe(false);
    await expect(getItem('k')).rejects.toThrow(/persistent storage is unavailable/);
    await expect(setItem('k', 'v')).rejects.toThrow(/persistent storage is unavailable/);
    expect(() => requireStorage()).toThrow(/persistent storage is unavailable/);
  });

  it('routes the OneTap device token through the injected adapter', async () => {
    const writes: Array<[string, string]> = [];
    const backing = createMemoryStorage();
    const instrumented: QuickAuthStorageAdapter = {
      getItem: (key) => backing.getItem(key),
      setItem: async (key, value) => {
        writes.push([key, value]);
        return backing.setItem(key, value);
      },
      removeItem: (key) => backing.removeItem(key),
    };
    await QuickAuth.init({ onTokenExpiry: tokenProvider, storage: instrumented });

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'OTP_SENT',
            sessionId: 's_1',
            expiresIn: 300,
            deviceToken: 'dtok_persisted',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ state: 'OTP_SENT', sessionId: 's_2', expiresIn: 300 }),
      });

    await initiate({ phone: '+919876543210' });
    expect(writes).toContainEqual(['qa_device_token', 'dtok_persisted']);

    // A fresh process would reload it from the adapter — simulate by dropping
    // only the in-memory cache.
    __resetSession();
    await initiate({ phone: '+919876543210' });
    const second = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(second.deviceToken).toBe('dtok_persisted');
  });
});
