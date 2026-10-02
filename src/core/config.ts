import type {
  AuthEventHandler,
  QuickAuthConfig,
  QuickAuthStorageAdapter,
  TokenProvider,
} from '../types';

export type { TokenProvider };

export interface ResolvedConfig {
  apiBaseUrl: string;
  publishableKey: string | null;
  onTokenExpiry: TokenProvider | null;
  initialToken: string | null;
  unsafe: { clientId: string; clientSecret: string } | null;
  maxRetries: number;
  requestTimeoutMs: number;
  silent: boolean;
  onAuthEvent: AuthEventHandler | null;
  storage: QuickAuthStorageAdapter | null;
}

const DEFAULTS = {
  apiBaseUrl: 'https://api.quickauth.in',
  maxRetries: 2,
  requestTimeoutMs: 15_000,
  silent: false,
} as const;

let current: ResolvedConfig | null = null;

export function setConfig(input: QuickAuthConfig): ResolvedConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('[QuickAuth] init() requires a config object');
  }

  const hasPublishableKey =
    typeof input.publishableKey === 'string' && input.publishableKey.length > 0;
  const hasOnTokenExpiry = typeof input.onTokenExpiry === 'function';
  const hasUnsafe = !!(
    input.unsafe &&
    typeof input.unsafe.clientId === 'string' &&
    input.unsafe.clientId.length > 0 &&
    typeof input.unsafe.clientSecret === 'string' &&
    input.unsafe.clientSecret.length > 0
  );

  // Exactly one auth mode must be specified
  const authModes = [hasPublishableKey, hasOnTokenExpiry, hasUnsafe].filter(Boolean).length;
  if (authModes === 0) {
    throw new Error(
      '[QuickAuth] init() requires one of: publishableKey, onTokenExpiry, or unsafe.{clientId, clientSecret}'
    );
  }
  if (authModes > 1) {
    throw new Error(
      '[QuickAuth] init() accepts only one auth mode: pass either publishableKey, onTokenExpiry, or unsafe — not multiple'
    );
  }

  if (hasUnsafe && !input.silent) {
    // eslint-disable-next-line no-console
    console.warn(
      '[QuickAuth] ⚠️ UNSAFE mode: client_secret embedded; for trusted-enterprise only'
    );
  }

  current = {
    apiBaseUrl: input.apiBaseUrl ?? DEFAULTS.apiBaseUrl,
    publishableKey: hasPublishableKey ? (input.publishableKey as string) : null,
    onTokenExpiry: hasOnTokenExpiry ? (input.onTokenExpiry as TokenProvider) : null,
    initialToken:
      typeof input.initialToken === 'string' && input.initialToken.length > 0
        ? input.initialToken
        : null,
    unsafe: hasUnsafe
      ? {
          clientId: input.unsafe!.clientId,
          clientSecret: input.unsafe!.clientSecret,
        }
      : null,
    maxRetries: input.maxRetries ?? DEFAULTS.maxRetries,
    requestTimeoutMs: input.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    silent: input.silent ?? DEFAULTS.silent,
    onAuthEvent: typeof input.onAuthEvent === 'function' ? input.onAuthEvent : null,
    storage: input.storage ?? null,
  } as ResolvedConfig;
  return current;
}

/**
 * Replace the auth event handler after `init()` without re-initialising.
 * Only this field is mutable; other config is captured at init. Pass `null`
 * to detach.
 */
export function setAuthEventHandler(handler: AuthEventHandler | null): void {
  const cfg = getConfig();
  cfg.onAuthEvent = typeof handler === 'function' ? handler : null;
}

export function getConfig(): ResolvedConfig {
  if (!current) {
    throw new Error('[QuickAuth] not initialised — call QuickAuth.init() with publishableKey or onTokenExpiry first');
  }
  return current;
}

export function isInitialised(): boolean {
  return current !== null;
}

/** Test-only. Clears configured state. */
export function __resetConfig(): void {
  current = null;
}
