import type { AuthEventHandler, QuickAuthConfig, TokenProvider } from '../types';

export type { TokenProvider };

export interface ResolvedConfig {
  apiBaseUrl: string;
  onTokenExpiry: TokenProvider | null;
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
  const hasUnsafe = !!(
    input.unsafe &&
    typeof input.unsafe.clientId === 'string' &&
    input.unsafe.clientId.length > 0 &&
    typeof input.unsafe.clientSecret === 'string' &&
    input.unsafe.clientSecret.length > 0
  );
  const hasInitialToken =
    typeof input.initialToken === 'string' && input.initialToken.length > 0;

  if (!hasOnTokenExpiry && !hasUnsafe && !hasInitialToken) {
    throw new Error(
      '[QuickAuth] init() requires onTokenExpiry, unsafe.{clientId, clientSecret}, or initialToken'
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
    throw new Error('[QuickAuth] not initialised — call QuickAuth.init({ onTokenExpiry }) first');
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
