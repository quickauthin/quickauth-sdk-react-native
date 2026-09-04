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
 * - `OTP_AUTO_READ` — a code the SDK read for the user, from Android's SMS
 *   Retriever or a WhatsApp zero-tap / one-tap broadcast. The SDK does not
 *   submit it unless `initiate({ autoSubmit: true })` asked it to.
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
  /**
   * Verify an auto-read code without waiting for the merchant to forward it.
   *
   * Off by default: a merchant who wants to show the code landing in the
   * field before it is spent should get that unless they ask otherwise.
   *
   * Guarded by a one-shot latch per attempt. A merchant on `auto` can receive
   * the same code twice — once parsed out of the SMS, once broadcast by
   * WhatsApp — and submitting the second would verify a code the server has
   * already consumed, surfacing to the user as a failure arriving right after
   * a success.
   *
   * Carried across `resendOtp()`, which repeats the request rather than
   * starting a differently-configured one.
   */
  autoSubmit?: boolean;
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
   */
  onTokenExpiry?: TokenProvider;
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
   * Where the SDK persists the OneTap device token and the last attribution
   * payload.
   *
   * Defaults to `@react-native-async-storage/async-storage`, a peer
   * dependency. If it is not installed, `init()` throws rather than quietly
   * keeping the device token in memory — a memory-only token means OneTap
   * silently stops working after every cold start, which is invisible in
   * development and expensive in production. Pass an adapter here (or
   * `createMemoryStorage()`, to accept that trade-off deliberately).
   */
  storage?: QuickAuthStorageAdapter;
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

/**
 * Persistent key-value storage the SDK uses for the device token (OneTap) and
 * the last captured attribution payload.
 *
 * Structurally identical to `@react-native-async-storage/async-storage`, so
 * that module satisfies it directly. Pass your own (MMKV, Keychain,
 * EncryptedStorage) via `QuickAuth.init({ storage })` when you would rather
 * not add AsyncStorage.
 */
export interface QuickAuthStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
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
