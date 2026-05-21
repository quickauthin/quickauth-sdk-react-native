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
}

export interface OtpStartParams {
  phone: string;
  channel?: OtpChannel;
  /** Optional locale hint passed to provider templates. */
  locale?: string;
  /** Caller-supplied metadata persisted on the auth session. */
  metadata?: Record<string, unknown>;
}

export interface OtpSession {
  sessionId: string;
  channel: OtpChannel;
  expiresAt: string;
  /** Android SMS Retriever app-hash echoed by backend. */
  smsRetrieverHash?: string;
}

export interface OtpVerifyParams {
  sessionId: string;
  code: string;
}

export interface OtpVerifyResult {
  success: boolean;
  jwt?: string;
  userId?: string;
  phone?: string;
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
