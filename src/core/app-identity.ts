/**
 * Host-app identity headers for publishable-key app-locking.
 *
 * A publishable key is designed to ship inside the binary, so on its own it is
 * copyable. The backend narrows it by pinning the key to the app identity it
 * was issued for (Android package / iOS bundle / web origin), which is why the
 * SDK volunteers that identity alongside the key.
 */

import { NativeModules, Platform } from 'react-native';

/** Captured once per process — the identity cannot change at runtime. */
let cached: Promise<Record<string, string>> | null = null;

/**
 * Best-effort — resolves to `{}` rather than rejecting when the identity is
 * unavailable. A missing header must never break authentication: the backend
 * falls back to its configured policy for the key, so degrading to "no
 * identity" is strictly better than failing the OTP the user is waiting on.
 */
export function appIdentityHeaders(): Promise<Record<string, string>> {
  if (!cached) cached = capture();
  return cached;
}

async function capture(): Promise<Record<string, string>> {
  try {
    // Web has no app identity to send — the browser sets `Origin`, which the
    // backend uses instead. Unknown platforms have nothing trustworthy.
    const header =
      Platform.OS === 'android'
        ? 'X-QuickAuth-Package'
        : Platform.OS === 'ios'
          ? 'X-QuickAuth-Bundle'
          : null;
    if (!header) return {};

    // Read from the SDK's own native module rather than pulling in a package
    // like react-native-device-info — the identity is one string and this
    // module is already auto-linked.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native: any = (NativeModules as Record<string, unknown>)
      .QuickAuthSmsRetriever;
    if (!native || typeof native.getAppIdentity !== 'function') return {};

    const id: unknown = await native.getAppIdentity();
    if (typeof id !== 'string' || id.length === 0) return {};
    return { [header]: id };
  } catch {
    return {};
  }
}

/** Test-only — drops the cached capture so the next call re-reads. */
export function __resetAppIdentity(): void {
  cached = null;
}
