/**
 * Host app identity from the native module's constants. Cached after first
 * read. Fields are undefined without the native module (Expo Go, tests, web).
 */

import { NativeModules, Platform } from 'react-native';

export interface AppIdentity {
  /** Android package name or iOS bundle identifier. */
  appId?: string;
  appVersion?: string;
  appBuild?: string;
}

let cached: AppIdentity | null = null;

export function getAppIdentity(): AppIdentity {
  if (cached) return cached;
  let out: AppIdentity = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = (NativeModules as any).QuickAuthSmsRetriever;
    // Old architecture spreads constants onto the module; the interop layer
    // exposes them through getConstants().
    const c = (typeof mod?.getConstants === 'function' ? mod.getConstants() : mod) ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    out = {
      appId: str(c.packageName) ?? str(c.bundleId),
      appVersion: str(c.appVersion),
      appBuild: str(c.appBuild),
    };
  } catch {
    out = {};
  }
  cached = out;
  return out;
}

/**
 * App identity headers for publishable-key requests: `X-QuickAuth-Package`
 * on Android, `X-QuickAuth-Bundle` on iOS (same as the Flutter SDK).
 */
export function appIdentityHeaders(): Record<string, string> {
  const { appId } = getAppIdentity();
  if (!appId) return {};
  if (Platform.OS === 'android') return { 'X-QuickAuth-Package': appId };
  if (Platform.OS === 'ios') return { 'X-QuickAuth-Bundle': appId };
  return {};
}

/** Test-only. */
export function __resetAppIdentity(): void {
  cached = null;
}
