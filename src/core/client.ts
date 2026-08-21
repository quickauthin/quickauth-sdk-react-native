/**
 * HTTP client — fetch wrapper with retries, idempotency keys, per-request
 * timeouts via AbortController, and either publishable-key or ephemeral
 * session-token bearer auth.
 */

import { appIdentityHeaders } from './app-identity';
import { getConfig } from './config';
import type { TokenProvider } from '../types';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Custom idempotency key. Auto-generated for POST when omitted. */
  idempotencyKey?: string;
  /** Override request timeout. */
  timeoutMs?: number;
  /** Override max retries. */
  maxRetries?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
}

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

/** Refresh threshold — refresh if fewer than this many ms remain. */
const REFRESH_LEEWAY_MS = 30_000;

function genIdempotencyKey(): string {
  // RFC4122-ish v4 (good enough for client idempotency keys)
  const rand = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `qa_${Date.now().toString(16)}_${rand(16)}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode base64url -> string. Avoids `atob` dependency (RN < 0.71 lacks it on
 * older Hermes; we fall back to a manual table when neither global is present).
 */
function decodeBase64Url(input: string): string {
  let str = input.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4 !== 0) str += '=';

  // Prefer global atob (RN ≥ 0.71, browsers).
  if (typeof globalThis !== 'undefined' && typeof (globalThis as { atob?: (s: string) => string }).atob === 'function') {
    return (globalThis as { atob: (s: string) => string }).atob(str);
  }
  // Node fallback (test runner).
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'base64').toString('binary');
  }
  // Manual fallback.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charAt(i);
    if (c === '=') break;
    const idx = chars.indexOf(c);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

/**
 * Read JWT exp (ms epoch) without verifying signature. Returns null if the
 * token is malformed or has no exp claim.
 */
export function getTokenExpiryMs(token: string): number | null {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = decodeBase64Url(parts[1]!);
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Manages the ephemeral session token — single-flight refresh + invalidate. */
export class TokenManager {
  private token: string | null;
  private expiryMs: number | null;
  private refreshing: Promise<string> | null;
  private readonly mintUnsafeToken: () => Promise<string>;

  constructor(opts: { initialToken?: string | null; mintUnsafeToken: () => Promise<string> }) {
    this.token = opts.initialToken ?? null;
    this.expiryMs = this.token ? getTokenExpiryMs(this.token) : null;
    this.refreshing = null;
    this.mintUnsafeToken = opts.mintUnsafeToken;
  }

  /** Returns a non-expired token, refreshing via the customer callback if needed. */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.expiryMs && this.expiryMs - now > REFRESH_LEEWAY_MS) {
      return this.token;
    }
    if (this.token && this.expiryMs === null) {
      // Token has no readable exp — trust it for one round-trip; refresh on 401.
      return this.token;
    }
    return this.refresh();
  }

  /** Forget the current token so the next getToken() refreshes. */
  invalidate(): void {
    this.token = null;
    this.expiryMs = null;
  }

  /** Single-flight refresh: concurrent callers share one in-flight promise. */
  private refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const cfg = getConfig();
    const provider: TokenProvider | null = cfg.onTokenExpiry;
    const useUnsafe = !provider && cfg.unsafe;

    const run = async (): Promise<string> => {
      let next: string;
      if (provider) {
        next = await provider();
      } else if (useUnsafe) {
        next = await this.mintUnsafeToken();
      } else {
        throw new Error(
          '[QuickAuth] no onTokenExpiry callback and no unsafe credentials configured'
        );
      }
      if (typeof next !== 'string' || !next) {
        throw new Error('[QuickAuth] onTokenExpiry returned an invalid token');
      }
      this.token = next;
      this.expiryMs = getTokenExpiryMs(next);
      return next;
    };

    this.refreshing = run().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}

let tokenManager: TokenManager | null = null;

/**
 * Mints a session token via the UNSAFE direct-to-API path (clientId/secret
 * embedded in app). NOT the same as the bearer-auth main flow.
 */
async function mintUnsafeToken(): Promise<string> {
  const cfg = getConfig();
  if (!cfg.unsafe) {
    throw new Error('[QuickAuth] unsafe credentials missing');
  }
  const url = `${cfg.apiBaseUrl.replace(/\/$/, '')}/v1/sdk/session`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Client-Id': cfg.unsafe.clientId,
        'X-Client-Secret': cfg.unsafe.clientSecret,
        'X-QuickAuth-SDK': 'react-native',
        'X-QuickAuth-SDK-Version': '0.1.0',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const err: ApiError = Object.assign(
        new Error(`[QuickAuth] /v1/sdk/session HTTP ${res.status}`),
        { status: res.status, body: parsed }
      );
      throw err;
    }
    const out = parsed as { sessionToken?: string; session_token?: string } | null;
    const tok = out?.sessionToken ?? out?.session_token;
    if (typeof tok !== 'string' || !tok) {
      throw new Error('[QuickAuth] /v1/sdk/session response missing sessionToken');
    }
    return tok;
  } finally {
    clearTimeout(timer);
  }
}

export function getTokenManager(): TokenManager {
  if (!tokenManager) {
    const cfg = getConfig();
    tokenManager = new TokenManager({
      initialToken: cfg.initialToken,
      mintUnsafeToken,
    });
  }
  return tokenManager;
}

/** Test-only — drop the cached manager so the next call rebuilds it. */
export function __resetTokenManager(): void {
  tokenManager = null;
}

export async function request<T = unknown>(opts: RequestOptions): Promise<T> {
  const cfg = getConfig();
  const method = opts.method ?? 'POST';
  const url = `${cfg.apiBaseUrl.replace(/\/$/, '')}${opts.path.startsWith('/') ? '' : '/'}${opts.path}`;
  const timeoutMs = opts.timeoutMs ?? cfg.requestTimeoutMs;
  const maxRetries = opts.maxRetries ?? cfg.maxRetries;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-QuickAuth-SDK': 'react-native',
    'X-QuickAuth-SDK-Version': '0.1.0',
  };

  // Publishable-key mode authenticates on the key plus the app identity alone.
  // There is no session token to mint, cache, refresh or invalidate, so the
  // token manager is never constructed — building it would invoke a token
  // provider the customer never configured.
  const tm = cfg.isPublishableKeyMode ? null : getTokenManager();
  if (tm) {
    headers.Authorization = `Bearer ${await tm.getToken()}`;
  } else {
    headers['X-QuickAuth-Key'] = cfg.publishableKey as string;
    Object.assign(headers, await appIdentityHeaders());
  }
  Object.assign(headers, opts.headers ?? {});

  if (method !== 'GET') {
    // Minted once and reused for every attempt below. A retry that mints a
    // fresh key is a *new* request to the backend, so a retried OTP send would
    // dispatch a second message instead of deduplicating to the first.
    headers['Idempotency-Key'] = opts.idempotencyKey ?? genIdempotencyKey();
  }

  let attempt = 0;
  let lastErr: ApiError | null = null;
  let refreshedAfter401 = false;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
        signal: controller.signal,
      });
      clearTimeout(timer);

      let parsed: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (res.ok) return parsed as T;

      const err: ApiError = Object.assign(
        new Error(`[QuickAuth] HTTP ${res.status} ${res.statusText || ''}`.trim()),
        { status: res.status, body: parsed }
      );

      // 401 — the token expired mid-flight. Swap in a fresh one and replay the
      // same request: retrying in-loop keeps the attempt budget and the
      // Idempotency-Key from the first send, both of which a recursive call
      // would silently reset. Latched, so at most one refresh per request.
      if (res.status === 401 && tm && !refreshedAfter401) {
        refreshedAfter401 = true;
        tm.invalidate();
        let fresh: string;
        try {
          fresh = await tm.getToken();
        } catch {
          throw err; // provider is broken — surface the 401, not its failure
        }
        headers.Authorization = `Bearer ${fresh}`;
        continue;
      }

      // 4xx — don't retry except 408. A 429 is the backend telling us it is
      // already over capacity for this caller; retrying on a blind backoff
      // just adds load to the limit that was imposed.
      if (res.status < 500 && res.status !== 408) throw err;
      lastErr = err;
    } catch (e) {
      clearTimeout(timer);
      const err = e as ApiError;
      // Bail immediately on a 4xx that isn't 408 (rethrown above).
      if (err && typeof err.status === 'number' && err.status < 500 && err.status !== 408) {
        throw err;
      }
      lastErr = err;
    }

    attempt += 1;
    if (attempt > maxRetries) break;
    const backoff = Math.min(1000 * 2 ** (attempt - 1), 4000);
    await sleep(backoff);
  }

  throw lastErr ?? new Error('[QuickAuth] request failed');
}
