/**
 * QuickAuth React Native SDK — Public type definitions.
 */

export enum OtpChannel {
  AUTO = 'auto',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
}

/**
 * Customer-supplied async function that mints a fresh QuickAuth session JWT by
 * calling the customer's own backend (which in turn calls
 * `POST /v1/sdk/session` server-to-server with X-Client-Id + X-Client-Secret).
 */
export type TokenProvider = () => Promise<string>;

/**
 * One callback for the entire auth lifecycle. Pass at `init()`.
 */
export type AuthEventHandler = (event: AuthEvent) => void;

/**
 * Typed auth lifecycle events. The SDK guarantees that for any given
 * `initiate()` call, you'll see at most one terminal event
 * (`VERIFIED` / `OTP_FAILED` / `ERROR`) for that attempt. Calling
 * `initiate()` again resets the state machine.
 *
 * - `OTP_SENT` — backend dispatched an OTP. Render the input.
 * - `OTP_AUTO_READ` — SMS auto-read (Android Retriever). SDK does NOT
 *   auto-submit; merchant decides whether to.
 * - `VERIFIED` — user is authenticated. Covers fresh OTP success AND silent
 *   device-trust re-auth. Forward `requestId` to the merchant backend.
 * - `OTP_FAILED` — submitted code was rejected. SDK stays in awaiting-OTP
 *   so the user can retry.
 * - `ERROR` — transport / rate-limit / unexpected failure. Final.
 */
export type AuthEvent =
  | { type: 'OTP_SENT'; sessionId: string; channel: OtpChannel; expiresIn: number }
  | { type: 'OTP_AUTO_READ'; code: string }
  | { type: 'VERIFIED'; requestId: string; message?: string }
  | { type: 'OTP_FAILED'; message: string }
  | { type: 'ERROR'; code: string; message: string };

export interface InitiateOptions {
  /** E.164 phone number, e.g. `+919876543210`. */
  phone: string;
  /** Delivery channel preference. Server picks if omitted or `auto`. */
  channel?: OtpChannel;
}

export interface ResetOptions {
  /**
   * Also clear the persistent device token. After reset, the next
   * `initiate()` acts like a brand-new install (no OneTap). Use on
   * user-initiated sign-out.
   */
  forgetDevice?: boolean;
}

export interface QuickAuthConfig {
  /** Override API base URL — defaults to https://api.quickauth.in */
  apiBaseUrl?: string;
  /**
   * Async callback invoked by the SDK whenever it needs a fresh session token.
   * The SDK calls this on first request, ~30s before token expiry, and on a 401.
   *
   * Exactly one of `onTokenExpiry` or `publishableKey` must be supplied.
   */
  onTokenExpiry?: TokenProvider;
  /**
   * Publishable key (`pk_live_…` / `pk_test_…`) — the in-app-safe credential
   * for the zero-backend auth mode.
   *
   * Unlike the client **secret**, a publishable key is *designed* to ship
   * inside the app: on the backend it is scoped to OTP initiate/verify only,
   * locked to your registered app identity (Android package / iOS bundle /
   * web origin), and rate-limited. When set, the SDK sends it as
   * `X-QuickAuth-Key` and never mints or attaches a session token.
   *
   * Exactly one of `onTokenExpiry` or `publishableKey` must be supplied.
   */
  publishableKey?: string;
  /** Optional pre-warmed token used for the very first request. */
  initialToken?: string;
  /**
   * UNSAFE escape hatch — for trusted-enterprise / server-rendered apps that
   * already embed secrets. When provided, the SDK calls `/v1/sdk/session`
   * directly with `X-Client-Id` + `X-Client-Secret` headers. NEVER ship this
   * in a public mobile binary.
   */
  unsafe?: {
    clientId: string;
    clientSecret: string;
  };
  /** Number of retries on 5xx / network errors. Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 15_000. */
  requestTimeoutMs?: number;
  /** Suppress console warnings. */
  silent?: boolean;
  /**
   * Headless auth event handler. The SDK invokes this with a typed
   * `AuthEvent` as the auth lifecycle progresses. One handler per init;
   * pass a new value to a subsequent `QuickAuth.init({ onAuthEvent })`
   * to replace.
   */
  onAuthEvent?: AuthEventHandler;
}

export interface WhatsAppLoginParams {
  businessNumber: string;
  message?: string;
}

export interface AttributionPayload {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  /** Raw click ID from launch URL (qa_click_id, gclid, fbclid…). */
  clickId?: string;
  /** Original launch URL (deep link). */
  launchUrl?: string;
  fingerprint: DeviceFingerprint;
  capturedAt: string;
}

export interface DeviceFingerprint {
  platform: 'ios' | 'android' | 'web' | 'unknown';
  osVersion?: string;
  appVersion?: string;
  screenWidth?: number;
  screenHeight?: number;
  pixelRatio?: number;
  timezone?: string;
  locale?: string;
}

export interface ConversionEvent {
  event: string;
  value?: number;
  currency?: string;
  attributes?: Record<string, unknown>;
}

export type OtpObserverCallback = (code: string) => void;

export interface OtpSubscription {
  remove(): void;
}
