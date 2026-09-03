/**
 * QuickAuth React Native SDK — public entry point.
 *
 * Two usage modes:
 *   1. Headless: QuickAuth.auth.initiate({ phone }), QuickAuth.auth.submitOtp(code), …
 *   2. Components: <QuickAuthLoginButton/>, <QuickAuthOtpField/>
 */

import {
  setConfig,
  getConfig,
  isInitialised,
  setAuthEventHandler,
  __resetConfig,
  type ResolvedConfig,
} from './core/config';
import { __resetTokenManager, getTokenManager, type TokenManager } from './core/client';
import * as consentApi from './core/consent';
import * as storageApi from './core/storage';
import * as otpApi from './auth/otp';
import * as whatsAppOtpApi from './auth/whatsapp-otp';
import * as captureApi from './attribution/capture';
import * as trackApi from './attribution/track';
import { fingerprint, fingerprintHash } from './attribution/fingerprint';
import { SDK_PLATFORM, SDK_VERSION } from './version';
import type {
  QuickAuthConfig,
  TokenProvider,
  AuthEvent,
  AuthEventHandler,
  InitiateOptions,
  ResetOptions,
  OtpObserverCallback,
  OtpSubscription,
  QuickAuthStorageAdapter,
  WhatsAppLoginParams,
  AttributionPayload,
  ConversionEvent,
  DeviceFingerprint,
} from './types';

export { OtpChannel } from './types';
export type {
  QuickAuthConfig,
  TokenProvider,
  AuthEvent,
  AuthEventHandler,
  InitiateOptions,
  ResetOptions,
  OtpObserverCallback,
  OtpSubscription,
  QuickAuthStorageAdapter,
  WhatsAppLoginParams,
  AttributionPayload,
  ConversionEvent,
  DeviceFingerprint,
};

/** An adapter that forgets everything when the process does. See `init({ storage })`. */
export { createMemoryStorage } from './core/storage';

/** The one place the SDK version is defined — derived from package.json at build time. */
export { SDK_VERSION, SDK_PLATFORM };

async function init(config: QuickAuthConfig): Promise<void> {
  // Resolved before the config is installed, so a failed init leaves the SDK
  // uninitialised rather than half-initialised. Eager, so a missing
  // AsyncStorage fails on the developer's first run rather than showing up
  // months later as "OneTap stopped working" for returning users.
  storageApi.setStorageAdapter(config?.storage);
  storageApi.requireStorage();
  setConfig(config);
  // Drop any cached TokenManager from a prior init — fresh config = fresh tokens.
  __resetTokenManager();
  // Wire deep-link listener so subsequent URLs auto-attribute.
  try {
    captureApi.startLinkingListener();
  } catch {
    /* noop in non-RN environments */
  }
}

/**
 * Tear the SDK down: end any auth attempt, stop auto-read, drop the cached
 * session token and forget the configuration. `isInitialized()` is false
 * afterwards and `init()` must be called again.
 *
 * The persisted device token survives — a teardown is not a sign-out. Use
 * `QuickAuth.auth.reset({ forgetDevice: true })` for that.
 */
async function reset(): Promise<void> {
  await otpApi.reset();
  __resetTokenManager();
  __resetConfig();
}

const QuickAuth = {
  init,
  reset,

  /** Whether `init()` has run. */
  isInitialized: (): boolean => isInitialised(),
  /** @deprecated spelling kept for 1.x callers — use `isInitialized`. */
  isInitialised,

  /** The resolved, defaulted configuration. Throws before `init()`. */
  config: (): ResolvedConfig => getConfig(),

  /** Session-token manager — exposed for tests and advanced flows. */
  tokenManager: (): TokenManager => getTokenManager(),

  /**
   * Replace the auth event handler after `init()` — for apps that attach it
   * when a screen mounts rather than at startup.
   */
  setAuthEventHandler: (handler: AuthEventHandler | null): void =>
    setAuthEventHandler(handler),

  consent: {
    set: (granted: boolean) => consentApi.set(granted),
    get: () => consentApi.get(),
  },

  auth: {
    initiate: (opts: InitiateOptions) => otpApi.initiate(opts),
    submitOtp: (code: string) => otpApi.submitOtp(code),
    /** Replay the live attempt's phone, channel and autoSubmit. No arguments. */
    resendOtp: () => otpApi.resendOtp(),
    reset: (opts?: ResetOptions) => otpApi.reset(opts),
    /** Feed a code in from your own observer; honours the auto-submit latch. */
    publishAutoReadCode: (code: string) => otpApi.publishAutoReadCode(code),
    observeOTP: (cb: OtpObserverCallback): OtpSubscription => otpApi.observeOTP(cb),
    startWhatsAppLogin: (p: WhatsAppLoginParams) => otpApi.startWhatsAppLogin(p),
    getSmsRetrieverHash: () => otpApi.getSmsRetrieverHash(),
    /** One hash per signing certificate — apps with a rotated key have several. */
    getSmsRetrieverHashes: () => otpApi.getSmsRetrieverHashes(),
  },

  whatsapp: {
    /** Open a chat with the business number. `false` when WhatsApp is absent. */
    open: (p: WhatsAppLoginParams) => otpApi.openWhatsApp(p),
    /** Broadcast Meta's OTP handshake by hand. `initiate()` already does this. */
    sendOtpHandshake: () => whatsAppOtpApi.sendHandshake(),
    /** Drop a zero-tap code held from an earlier attempt. */
    clearPendingOtp: () => whatsAppOtpApi.clearPending(),
    /** WhatsApp zero-tap / one-tap codes only, unmerged with SMS. */
    observeOtp: (cb: OtpObserverCallback): OtpSubscription => whatsAppOtpApi.observe(cb),
  },

  attribution: {
    captureLaunch: () => captureApi.captureLaunch(),
    capture: (url: string | null) => captureApi.capture(url),
    trackConversion: (e: ConversionEvent) => trackApi.trackConversion(e),
    getFingerprint: (): DeviceFingerprint => fingerprint(),
    getFingerprintHash: (): string => fingerprintHash(fingerprint()),
    getLastAttribution: (): AttributionPayload | null => captureApi.getLastAttribution(),
  },
};

export default QuickAuth;

// Re-export components for direct named imports.
export { QuickAuthLoginButton } from './ui/QuickAuthLoginButton';
export type { QuickAuthLoginButtonProps } from './ui/QuickAuthLoginButton';
export { QuickAuthOtpField } from './ui/QuickAuthOtpField';
export type { QuickAuthOtpFieldProps } from './ui/QuickAuthOtpField';
export { colors, radius, spacing, typography } from './ui/theme';
