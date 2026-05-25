/**
 * QuickAuth React Native SDK — public entry point.
 *
 * Two usage modes:
 *   1. Headless: QuickAuth.auth.startOTP(...), QuickAuth.attribution.captureLaunch(), …
 *   2. Components: <QuickAuthLoginButton/>, <QuickAuthOtpField/>
 */

import { setConfig, isInitialised } from './core/config';
import { __resetTokenManager } from './core/client';
import * as consentApi from './core/consent';
import * as otpApi from './auth/otp';
import * as captureApi from './attribution/capture';
import * as trackApi from './attribution/track';
import { fingerprint, fingerprintHash } from './attribution/fingerprint';
import type {
  QuickAuthConfig,
  TokenProvider,
  AuthEvent,
  AuthEventHandler,
  InitiateOptions,
  ResetOptions,
  OtpObserverCallback,
  OtpSubscription,
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
  WhatsAppLoginParams,
  AttributionPayload,
  ConversionEvent,
  DeviceFingerprint,
};

async function init(config: QuickAuthConfig): Promise<void> {
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

const QuickAuth = {
  init,
  isInitialised,

  consent: {
    set: (granted: boolean) => consentApi.set(granted),
    get: () => consentApi.get(),
  },

  auth: {
    initiate: (opts: InitiateOptions) => otpApi.initiate(opts),
    submitOtp: (code: string) => otpApi.submitOtp(code),
    reset: (opts?: ResetOptions) => otpApi.reset(opts),
    observeOTP: (cb: OtpObserverCallback): OtpSubscription => otpApi.observeOTP(cb),
    startWhatsAppLogin: (p: WhatsAppLoginParams) => otpApi.startWhatsAppLogin(p),
    getSmsRetrieverHash: () => otpApi.getSmsRetrieverHash(),
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
