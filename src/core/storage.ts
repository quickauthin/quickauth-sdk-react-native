/**
 * Persistent key-value storage for the device token and last attribution.
 *
 * The device token is what OneTap is: the backend hands it back on
 * `/initiate`, the SDK replays it on the next one, and the user is verified
 * without an OTP. It only works if the token outlives the process.
 *
 * This module used to duck-type `@react-native-async-storage/async-storage`
 * and, when it was not installed, fall back to a `Map` — so everything
 * appeared to work in a session and OneTap silently never fired again after
 * a cold start. Nothing logged, nothing threw, and the merchant's own tests
 * (single session) passed. That is now a hard, immediate error at `init()`
 * instead: either the peer dependency is installed, or the app passes its own
 * adapter, or it explicitly opts into the memory adapter and accepts that
 * OneTap does not survive a restart.
 */

import type { QuickAuthStorageAdapter } from '../types';

export type { QuickAuthStorageAdapter };

/** Explicitly injected via `QuickAuth.init({ storage })`. Wins over AsyncStorage. */
let injected: QuickAuthStorageAdapter | null = null;

/** Resolved backend — injected adapter or the AsyncStorage peer dependency. */
let resolved: QuickAuthStorageAdapter | null = null;

function looksLikeAdapter(candidate: unknown): candidate is QuickAuthStorageAdapter {
  const c = candidate as Partial<QuickAuthStorageAdapter> | null;
  return (
    !!c &&
    typeof c.getItem === 'function' &&
    typeof c.setItem === 'function' &&
    typeof c.removeItem === 'function'
  );
}

function loadAsyncStorage(): QuickAuthStorageAdapter | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-async-storage/async-storage');
    const candidate = mod?.default ?? mod;
    return looksLikeAdapter(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const MISSING_STORAGE_MESSAGE =
  '[QuickAuth] persistent storage is unavailable.\n' +
  '  QuickAuth stores the device token that powers OneTap (silent re-auth). Without\n' +
  '  storage that survives a cold start, every returning user is asked for an OTP again.\n' +
  '  Fix by doing one of:\n' +
  '    1. npm install @react-native-async-storage/async-storage   (recommended — it is a\n' +
  '       peer dependency of this SDK), then rebuild the native app; or\n' +
  '    2. QuickAuth.init({ storage: myAdapter })  — any { getItem, setItem, removeItem }\n' +
  '       returning promises (MMKV, Keychain, EncryptedStorage, …); or\n' +
  '    3. QuickAuth.init({ storage: createMemoryStorage() })  — explicitly accept that\n' +
  '       OneTap will not survive an app restart.';

/**
 * Install an explicit adapter. Called by `init()` with `config.storage`;
 * passing `undefined` clears a previous injection.
 */
export function setStorageAdapter(adapter?: QuickAuthStorageAdapter | null): void {
  if (adapter != null && !looksLikeAdapter(adapter)) {
    throw new Error(
      '[QuickAuth] init({ storage }) must be an object with async getItem/setItem/removeItem'
    );
  }
  injected = adapter ?? null;
  resolved = null;
}

/**
 * The storage backend, or a thrown error naming the three ways to supply one.
 *
 * Called eagerly by `init()` so the failure lands on the developer's very
 * first run rather than on a returning user's second launch weeks later.
 */
export function requireStorage(): QuickAuthStorageAdapter {
  if (resolved) return resolved;
  const backend = injected ?? loadAsyncStorage();
  if (!backend) throw new Error(MISSING_STORAGE_MESSAGE);
  resolved = backend;
  return resolved;
}

/** Whether a backend is available without throwing. */
export function hasStorage(): boolean {
  try {
    requireStorage();
    return true;
  } catch {
    return false;
  }
}

/**
 * An in-memory adapter. Not a fallback the SDK picks on its own — it has to
 * be passed to `init({ storage })`, which is the point: losing OneTap across
 * restarts becomes a decision someone made rather than something that
 * happened.
 */
export function createMemoryStorage(): QuickAuthStorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: async (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
  };
}

export async function getItem(key: string): Promise<string | null> {
  return requireStorage().getItem(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  return requireStorage().setItem(key, value);
}

export async function removeItem(key: string): Promise<void> {
  return requireStorage().removeItem(key);
}

/**
 * Test-only — forget the injected adapter and the resolved backend.
 *
 * Also empties the backend when it advertises the test hook below, which the
 * SDK's own jest mock of AsyncStorage does and a real AsyncStorage never
 * will. Without that a key written by one test would still be there in the
 * next one.
 */
export function __resetStorage(): void {
  const backend = injected ?? resolved;
  const hook = (backend as { __quickauthTestClear?: () => void } | null)?.__quickauthTestClear;
  if (typeof hook === 'function') hook();
  injected = null;
  resolved = null;
}
