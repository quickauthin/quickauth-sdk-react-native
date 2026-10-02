/**
 * QuickAuth React Native SDK public entry point.
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
  AttributionResult,
  ConversionEvent,
  DeviceFingerprint,
  DeviceInfo,
  LaunchFingerprint,
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
  AttributionResult,
  ConversionEvent,
  DeviceFingerprint,
  DeviceInfo,
  LaunchFingerprint,
};

/** In-memory storage adapter; does not survive restarts. See `init({ storage })`. */
export { createMemoryStorage } from './core/storage';

/** SDK version, generated from package.json at build time. */
export { SDK_VERSION, SDK_PLATFORM };

/**
 * Initialize the SDK. Choose ONE auth mode:
 *
 * 1. **Publishable Key (recommended)**, no backend needed:
 *    ```ts
 *    await QuickAuth.init({ publishableKey: 'pk_live_...' });
 *    ```
 *    Safe to embed: app-locked and rate-limited on the backend.
 *
 * 2. **Session Token**, requires your backend:
 *    ```ts
 *    await QuickAuth.init({
 *      onTokenExpiry: async () => {
 *        const res = await fetch('https://my-app.com/api/quickauth-token');
 *        return (await res.json()).sessionToken;
 *      }
 *    });
 *    ```
 *    Your backend calls `/v1/sdk/session` server-to-server.
 *
 * 3. **Unsafe Mode** (testing only), embeds the client secret:
 *    ```ts
 *    await QuickAuth.init({
 *      unsafe: { clientId: '...', clientSecret: '...' }
 *    });
 *    ```
 */
async function init(config: QuickAuthConfig): Promise<void> {
  // Resolve storage before installing config so a failed init leaves nothing
  // half-set. Eager so a missing AsyncStorage fails on first run.
  storageApi.setStorageAdapter(config?.storage);
  storageApi.requireStorage();
  setConfig(config);
  // Drop any TokenManager cached by a prior init.
  __resetTokenManager();
  // Re-read the device token from the (possibly new) storage on next use.
  otpApi.invalidateDeviceTokenCache();
  // Restore the user's saved consent choice (falls back to config.consent).
  await consentApi.hydrate(config.consent === true);
  // Wire deep-link listener so subsequent URLs auto-attribute.
  try {
    captureApi.startLinkingListener();
  } catch {
    /* noop in non-RN environments */
  }
}

/**
 * Tear down the SDK: ends any auth attempt, drops the session token and
 * config. Call `init()` again afterwards. Keeps the device token; use
 * `QuickAuth.auth.reset({ forgetDevice: true })` to sign out.
 */
async function reset(): Promise<void> {
  await otpApi.reset();
  // Queued attribution belongs to the torn-down session; the saved choice stays.
  consentApi.clearQueue();
  otpApi.invalidateDeviceTokenCache();
  __resetTokenManager();
  __resetConfig();
}

const QuickAuth = {
  init,
  reset,

  // Getters, not methods, to match the Flutter and Web SDKs.

  /** Whether `init()` has run. */
  get isInitialized(): boolean {
    return isInitialised()
  },
  /** @deprecated Use `isInitialized`. */
  get isInitialised(): boolean {
    return isInitialised()
  },

  /** The resolved, defaulted configuration. Throws before `init()`. */
  get config(): ResolvedConfig {
    return getConfig()
  },

  /** Session-token manager, for tests and advanced flows. */
  get tokenManager(): TokenManager {
    return getTokenManager()
  },

  /** Replace the auth event handler after `init()`. Pass `null` to detach. */
  setAuthEventHandler: (handler: AuthEventHandler | null): void =>
    setAuthEventHandler(handler),

  consent: {
    /** Saves the choice; granting replays queued attribution, revoking clears it. */
    set: (granted: boolean): Promise<boolean> => consentApi.set(granted),
    get: (): boolean => consentApi.get(),
    /** Attribution calls waiting for consent. */
    pendingCount: (): number => consentApi.pendingCount(),
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
    /** One hash per signing certificate (several if the key was rotated). */
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
    getLastAttribution: (): AttributionResult | null => captureApi.getLastAttribution(),
    /** The stored `qa_clid`, if a campaign link carried one. */
    qaClid: (): Promise<string | null> => captureApi.getQaClid(),
  },
};

export default QuickAuth;

// Re-export components for direct named imports.
export { QuickAuthLoginButton } from './ui/QuickAuthLoginButton';
export type { QuickAuthLoginButtonProps } from './ui/QuickAuthLoginButton';
export { QuickAuthOtpField } from './ui/QuickAuthOtpField';
export type { QuickAuthOtpFieldProps } from './ui/QuickAuthOtpField';
export { colors, radius, spacing, typography } from './ui/theme';
