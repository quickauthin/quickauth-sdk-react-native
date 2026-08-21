import type { AuthEventHandler, QuickAuthConfig, TokenProvider } from '../types';

export type { TokenProvider };

export interface ResolvedConfig {
  apiBaseUrl: string;
  onTokenExpiry: TokenProvider | null;
  publishableKey: string | null;
  /** True when the SDK should authenticate with `X-QuickAuth-Key` only. */
  isPublishableKeyMode: boolean;
  initialToken: string | null;
  unsafe: { clientId: string; clientSecret: string } | null;
  maxRetries: number;
  requestTimeoutMs: number;
  silent: boolean;
  onAuthEvent: AuthEventHandler | null;
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

  const hasOnTokenExpiry = typeof input.onTokenExpiry === 'function';
  const hasPublishableKey =
    typeof input.publishableKey === 'string' && input.publishableKey.length > 0;
  const hasUnsafe = !!(
    input.unsafe &&
    typeof input.unsafe.clientId === 'string' &&
    input.unsafe.clientId.length > 0 &&
    typeof input.unsafe.clientSecret === 'string' &&
    input.unsafe.clientSecret.length > 0
  );
  const hasInitialToken =
    typeof input.initialToken === 'string' && input.initialToken.length > 0;

  if (!hasPublishableKey && !hasOnTokenExpiry && !hasUnsafe && !hasInitialToken) {
    throw new Error(
      '[QuickAuth] init() requires an auth mode: pass publishableKey (recommended, ' +
        'zero-backend) or onTokenExpiry (server-minted session tokens).'
    );
  }

  // The two modes authenticate differently on the wire, so accepting both
  // would leave which one is actually in force up to the request layer.
  if (hasPublishableKey && hasOnTokenExpiry) {
    throw new Error(
      '[QuickAuth] Pass either publishableKey or onTokenExpiry — not both.'
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
    onTokenExpiry: hasOnTokenExpiry ? (input.onTokenExpiry as TokenProvider) : null,
    publishableKey: hasPublishableKey ? (input.publishableKey as string) : null,
    isPublishableKeyMode: hasPublishableKey,
    initialToken: hasInitialToken ? (input.initialToken as string) : null,
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
  };
  return current;
}

export function getConfig(): ResolvedConfig {
  if (!current) {
    throw new Error(
      '[QuickAuth] not initialised — call QuickAuth.init({ publishableKey }) first'
    );
  }
  return current;
}

export function isInitialised(): boolean {
  return current !== null;
}

/** Test-only — clears configured state. */
export function __resetConfig(): void {
  current = null;
}
