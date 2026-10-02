/**
 * QuickAuth React Native SDK public type definitions.
 */

export enum OtpChannel {
  AUTO = 'auto',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
}

/**
 * Returns a fresh session JWT from your backend, which calls
 * `POST /v1/sdk/session` with X-Client-Id + X-Client-Secret.
 */
export type TokenProvider = () => Promise<string>;

/**
 * One callback for the entire auth lifecycle. Pass at `init()`.
 */
export type AuthEventHandler = (event: AuthEvent) => void;

/**
 * Auth lifecycle events. At most one terminal event (`VERIFIED` /
 * `OTP_FAILED` / `ERROR`) per `initiate()` call.
 *
 * - `OTP_SENT`: OTP dispatched. Render the input.
 * - `OTP_AUTO_READ`: code read from SMS Retriever or WhatsApp zero-tap/one-tap.
 *   Only submitted if `initiate({ autoSubmit: true })`.
 * - `VERIFIED`: authenticated (OTP or OneTap). Forward `requestId` to your backend.
 * - `OTP_FAILED`: code rejected. User can retry.
 * - `ERROR`: transport, rate-limit or unexpected failure. Final.
 */
export type AuthEvent =
  | { type: 'OTP_SENT'; sessionId: string; channel: OtpChannel; expiresIn: number }
  | { type: 'OTP_AUTO_READ'; code: string }
  | { type: 'VERIFIED'; requestId: string; message?: string }
  | { type: 'OTP_FAILED'; message: string }
  | {
      type: 'ERROR';
      /** Category: RATE_LIMITED, SERVER_ERROR, CLIENT_ERROR or UNKNOWN_ERROR. */
      code: string;
      message: string;
      /** The backend's own reason (e.g. `INVALID_CLIENT_CREDENTIALS`), when it sent one. */
      errorCode?: string;
      /** HTTP status, when the failure was an HTTP response. */
      status?: number;
    };

export interface InitiateOptions {
  /** E.164 phone number, e.g. `+919876543210`. */
  phone: string;
  /** Delivery channel preference. Server picks if omitted or `auto`. */
  channel?: OtpChannel;
  /**
   * Submit an auto-read code automatically. Default `false`. Submits at most
   * once per attempt (SMS and WhatsApp may deliver the same code). Kept
   * across `resendOtp()`.
   */
  autoSubmit?: boolean;
}

export interface ResetOptions {
  /** Also clear the device token, so the next `initiate()` skips OneTap. Use on sign-out. */
  forgetDevice?: boolean;
}

export interface QuickAuthConfig {
  /** API base URL. Default https://api.quickauth.in */
  apiBaseUrl?: string;
  /**
   * Publishable key (`pk_live_…` / `pk_test_…`), safe to ship in the app.
   * Scoped to OTP initiate/verify, locked to your app and rate-limited.
   * Use exactly one of `publishableKey`, `onTokenExpiry` or `unsafe`.
   */
  publishableKey?: string;
  /**
   * Returns a fresh session token. Called on first request, ~30s before
   * expiry, and on a 401. Use exactly one auth mode.
   */
  onTokenExpiry?: TokenProvider;
  /** Optional pre-warmed token used for the very first request. */
  initialToken?: string;
  /**
   * UNSAFE: SDK calls `/v1/sdk/session` directly with the client secret.
   * Trusted-enterprise/testing only. Never ship in a public app.
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
   * Initial DPDP/GDPR consent for attribution. Default `false`. A choice
   * saved via `consent.set()` takes precedence.
   */
  consent?: boolean;
  /**
   * Storage for the OneTap device token and attribution data. Defaults to
   * `@react-native-async-storage/async-storage`; `init()` throws if it is
   * missing and no adapter is passed. `createMemoryStorage()` loses OneTap on restart.
   */
  storage?: QuickAuthStorageAdapter;
  /** Receives `AuthEvent`s. Replace later with `QuickAuth.setAuthEventHandler()`. */
  onAuthEvent?: AuthEventHandler;
}

export interface WhatsAppLoginParams {
  businessNumber: string;
  message?: string;
}

/**
 * Async key-value storage, compatible with AsyncStorage. Pass MMKV, Keychain,
 * etc. via `QuickAuth.init({ storage })`.
 */
export interface QuickAuthStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Backend result for an attribution launch. */
export interface AttributionResult {
  /** Whether the launch was matched to a campaign click. */
  matched: boolean;
  /** Click id (`qa_clid`), from the link or assigned by the backend. */
  qaClid?: string;
  campaignId?: string;
  templateId?: string;
  variantId?: string;
}

/** @deprecated Use {@link AttributionResult}. */
export type AttributionPayload = AttributionResult;

/** Fingerprint sent with attribution launches (same shape as the Flutter SDK). */
export interface LaunchFingerprint {
  /** Random id generated once per install. */
  anchor: string;
  locale: string;
  /** UTC offset in minutes. */
  tz: number;
  /** Screen size in physical pixels. */
  screenW: number | null;
  screenH: number | null;
  dpr: number | null;
  /** 64-bit FNV-1a of the fields above. */
  hash: string;
}

/** Device metadata sent as `deviceInfo` (same shape as the Flutter SDK). */
export interface DeviceInfo {
  platform: string;
  osVersion?: string;
  locale?: string;
  timeZoneOffsetMinutes: number;
  appVersion?: string;
  appBuild?: string;
  appId?: string;
  /** `react-native/<version>` */
  sdk: string;
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
  /** Free-form properties stored with the conversion. */
  metadata?: Record<string, unknown>;
  /** @deprecated Use `metadata`. Sent as `metadata`. */
  attributes?: Record<string, unknown>;
}

export type OtpObserverCallback = (code: string) => void;

export interface OtpSubscription {
  remove(): void;
}
