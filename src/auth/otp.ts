/**
 * Headless auth state machine.
 *
 * Public API:
 *   QuickAuth.auth.initiate({ phone, channel, autoSubmit })
 *   QuickAuth.auth.submitOtp(code)
 *   QuickAuth.auth.resendOtp()
 *   QuickAuth.auth.reset({ forgetDevice })
 *   QuickAuth.auth.publishAutoReadCode(code)
 *   QuickAuth.auth.observeOTP(cb)
 *
 * Outcomes are emitted via `QuickAuthConfig.onAuthEvent`; async methods
 * resolve when the network call completes. Concurrent `initiate()` calls:
 * latest wins.
 *
 * State machine (same as web, iOS, Android, Flutter):
 *   idle → sending → awaiting_otp → verifying → verified
 *                  └ verified                 └ awaiting_otp (retry on OTP_FAILED)
 *                  └ failed
 */

import { captureDeviceInfo } from '../attribution/device-info';
import { request } from '../core/client';
import * as consent from '../core/consent';
import { getConfig } from '../core/config';
import * as storage from '../core/storage';
import {
  OtpChannel,
  type AuthEvent,
  type DeviceInfo,
  type InitiateOptions,
  type OtpObserverCallback,
  type OtpSubscription,
  type ResetOptions,
} from '../types';
import * as smsRetriever from './sms-retriever';
import * as whatsAppOtp from './whatsapp-otp';
import { openWhatsApp, startWhatsAppLogin } from './whatsapp';

const DEVICE_TOKEN_KEY = 'qa_device_token';
const E164 = /^\+[1-9]\d{6,14}$/;
const OTP_CODE = /^\d{4,8}$/;

interface InitiateResponse {
  state?: 'OTP_SENT' | 'VERIFIED';
  sessionId: string;
  expiresIn: number;
  deviceToken?: string;
}

interface VerifyResponse {
  state?: 'VERIFIED' | 'OTP_FAILED';
  verified: boolean;
  requestId: string;
  message: string;
}

type SessionState =
  | { kind: 'idle' }
  | { kind: 'sending'; attemptId: number }
  | { kind: 'awaiting_otp'; attemptId: number; sessionId: string }
  | { kind: 'verifying'; attemptId: number; sessionId: string }
  | { kind: 'verified'; attemptId: number; requestId: string }
  | { kind: 'failed'; attemptId: number };

let state: SessionState = { kind: 'idle' };
let attemptCounter = 0;
let cachedDeviceToken: string | null | undefined = undefined; // undefined = not loaded yet

// Live attempt, kept so resendOtp() takes no args and can't target a different number.
let activePhone: string | null = null;
let activeChannel: OtpChannel = OtpChannel.AUTO;

let autoSubmitEnabled = false;

// One auto-submit per attempt: SMS and WhatsApp can deliver the same code.
let autoSubmitted = false;

// Dedupes OTP_AUTO_READ within an attempt (SDK + caller subscriptions, SMS +
// WhatsApp copies). Reset per attempt so a resend of the same code refills.
let lastAnnouncedCode: string | null = null;

// SDK-owned subscriptions, so auto-read works without the caller calling observeOTP.
let autoReadSubs: OtpSubscription[] = [];

/**
 * Drop the in-memory token so the next read hits storage. Called from init()
 * and QuickAuth.reset(), since the storage adapter may have changed.
 */
export function invalidateDeviceTokenCache(): void {
  cachedDeviceToken = undefined;
}

async function loadDeviceToken(): Promise<string | null> {
  if (cachedDeviceToken !== undefined) return cachedDeviceToken;
  try {
    cachedDeviceToken = await storage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    cachedDeviceToken = null;
  }
  return cachedDeviceToken;
}

async function saveDeviceToken(token: string): Promise<void> {
  cachedDeviceToken = token;
  try {
    await storage.setItem(DEVICE_TOKEN_KEY, token);
  } catch (err) {
    // Cached in memory for this session only; OneTap won't survive a restart.
    // getConfig() may throw if torn down, so read `silent` defensively.
    let silent = false;
    try {
      silent = getConfig().silent;
    } catch {
      /* not initialised any more; report it */
    }
    if (!silent) {
      // eslint-disable-next-line no-console
      console.error(
        '[QuickAuth] failed to persist the device token — OneTap will not survive an app restart:',
        err
      );
    }
  }
}

async function clearDeviceToken(): Promise<void> {
  cachedDeviceToken = null;
  try {
    await storage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* noop: nothing persisted */
  }
}

function emit(event: AuthEvent): void {
  const handler = getConfig().onAuthEvent;
  if (!handler) return;
  // Defer to a microtask so delivery is off the awaited promise's resolution path.
  Promise.resolve().then(() => {
    try {
      handler(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[QuickAuth] onAuthEvent handler threw:', err);
    }
  });
}

function classifyError(err: unknown): string {
  const e = err as { code?: string; status?: number };
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.status === 'number') {
    if (e.status === 429) return 'RATE_LIMITED';
    if (e.status >= 500) return 'SERVER_ERROR';
    if (e.status >= 400) return 'CLIENT_ERROR';
  }
  return 'UNKNOWN_ERROR';
}

/** ERROR event, with the backend's errorCode/status when present. */
function errorEvent(err: unknown): AuthEvent {
  const e = err as { errorCode?: unknown; status?: unknown };
  const event: AuthEvent = { type: 'ERROR', code: classifyError(err), message: errorMessage(err) };
  if (typeof e?.errorCode === 'string') event.errorCode = e.errorCode;
  if (typeof e?.status === 'number') event.status = e.status;
  return event;
}

/** Device info for audit, only with consent. Never throws. */
function deviceInfoIfConsented(): DeviceInfo | null {
  if (!consent.get()) return null;
  try {
    return captureDeviceInfo();
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  return typeof e?.message === 'string' ? e.message : 'Request failed';
}

/**
 * Start an auth attempt. Emits `OTP_SENT`, or `VERIFIED` on OneTap. Rejects only
 * on validation or transport failure. Arms auto-read (no need to call
 * {@link observeOTP}). Latest call wins.
 */
export async function initiate(opts: InitiateOptions): Promise<void> {
  const phone = opts?.phone;
  if (typeof phone !== 'string' || !E164.test(phone.trim())) {
    throw new Error('[QuickAuth] initiate: phone must be E.164 (e.g. +919876543210)');
  }
  // Throw if not initialised, before any side effects.
  getConfig();
  const channel = opts.channel ?? OtpChannel.AUTO;
  const autoSubmit = opts.autoSubmit === true;
  const trimmed = phone.trim();
  const attemptId = ++attemptCounter;
  state = { kind: 'sending', attemptId };

  // Per request (a session covers one SMS). Not awaited; must not block delivery.
  void smsRetriever.start();
  // Drop a WhatsApp code held from a previous attempt; it would fail against this one.
  await whatsAppOtp.clearPending();
  // Send handshake before requesting the OTP; WhatsApp checks for it on receipt.
  await whatsAppOtp.sendHandshake();

  activePhone = trimmed;
  activeChannel = channel;
  autoSubmitEnabled = autoSubmit;
  autoSubmitted = false;
  lastAnnouncedCode = null;
  listenForAutoRead();

  const deviceToken = await loadDeviceToken();
  const body: Record<string, unknown> = {
    phone: trimmed,
    channel,
  };
  if (deviceToken) body.deviceToken = deviceToken;
  const initiateDeviceInfo = deviceInfoIfConsented();
  if (initiateDeviceInfo) body.deviceInfo = initiateDeviceInfo;

  let res: InitiateResponse;
  try {
    res = await request<InitiateResponse>({
      method: 'POST',
      path: '/v1/sdk/auth/initiate',
      body,
    });
  } catch (err) {
    if (state.kind === 'sending' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId };
      emit(errorEvent(err));
    }
    throw err;
  }

  if (state.kind !== 'sending' || state.attemptId !== attemptId) return;

  if (res.deviceToken) {
    await saveDeviceToken(res.deviceToken);
  }

  if (res.state === 'VERIFIED') {
    state = { kind: 'verified', attemptId, requestId: res.sessionId };
    emit({ type: 'VERIFIED', requestId: res.sessionId });
    return;
  }

  state = { kind: 'awaiting_otp', attemptId, sessionId: res.sessionId };
  emit({
    type: 'OTP_SENT',
    sessionId: res.sessionId,
    channel,
    // Default OTP window if the backend omits it (matches Flutter).
    expiresIn: typeof res.expiresIn === 'number' ? res.expiresIn : 300,
  });
}

/**
 * Resend to the current attempt's number, reusing its channel and `autoSubmit`.
 * Within the expiry window the server resends the same code; after it, a new one.
 * Rejects if there is no active attempt (call `initiate()` first).
 */
export async function resendOtp(): Promise<void> {
  const phone = activePhone;
  if (!phone) {
    throw new Error('[QuickAuth] resendOtp: nothing to resend — call initiate() first.');
  }
  return initiate({ phone, channel: activeChannel, autoSubmit: autoSubmitEnabled });
}

export async function submitOtp(code: string): Promise<void> {
  if (typeof code !== 'string' || !OTP_CODE.test(code)) {
    throw new Error('[QuickAuth] submitOtp: code must be 4–8 digits');
  }
  if (state.kind !== 'awaiting_otp') {
    throw new Error(
      `[QuickAuth] submitOtp called in state "${state.kind}" — must follow an OTP_SENT event`
    );
  }
  const { attemptId, sessionId } = state;
  state = { kind: 'verifying', attemptId, sessionId };

  const deviceToken = await loadDeviceToken();
  const body: Record<string, unknown> = { sessionId, code };
  if (deviceToken) body.deviceToken = deviceToken;
  const verifyDeviceInfo = deviceInfoIfConsented();
  if (verifyDeviceInfo) body.deviceInfo = verifyDeviceInfo;

  let res: VerifyResponse;
  try {
    res = await request<VerifyResponse>({
      method: 'POST',
      path: '/v1/sdk/auth/verify',
      body,
    });
  } catch (err) {
    if (state.kind === 'verifying' && state.attemptId === attemptId) {
      state = { kind: 'failed', attemptId };
      emit(errorEvent(err));
    }
    throw err;
  }

  if (state.kind !== 'verifying' || state.attemptId !== attemptId) return;

  const isVerified = res.state === 'VERIFIED' || (res.state == null && res.verified);
  if (isVerified) {
    state = { kind: 'verified', attemptId, requestId: res.requestId };
    emit({ type: 'VERIFIED', requestId: res.requestId, message: res.message });
    return;
  }

  state = { kind: 'awaiting_otp', attemptId, sessionId };
  emit({ type: 'OTP_FAILED', message: res.message });
}

/**
 * Reset the state machine and stop auto-read. `forgetDevice: true` also clears
 * the device token, so the next `initiate()` gets no OneTap.
 */
export async function reset(opts?: ResetOptions): Promise<void> {
  stopAutoRead();
  state = { kind: 'idle' };
  attemptCounter++; // invalidate any in-flight attempt
  if (opts?.forgetDevice) {
    await clearDeviceToken();
  }
}

/**
 * Feed in a code from outside the SDK (paste, iOS autofill, tests). Emits
 * `OTP_AUTO_READ` and may auto-submit, same as an auto-read code. A code
 * already announced for this attempt is not emitted again.
 */
export function publishAutoReadCode(code: string): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) return;
  announce(trimmed);
}

/**
 * Subscribe to auto-read codes from SMS and WhatsApp (Android). Optional, since
 * `initiate()` already subscribes; `OTP_AUTO_READ` still fires once per code.
 * @returns a subscription; call `remove()` to stop.
 */
export function observeOTP(callback: OtpObserverCallback): OtpSubscription {
  const subs = [
    smsRetriever.observe((code) => {
      callback(code);
      announce(code);
    }),
    whatsAppOtp.observe((code) => {
      callback(code);
      announce(code);
    }),
  ];
  let removed = false;
  return {
    remove: () => {
      if (removed) return;
      removed = true;
      subs.forEach((s) => s.remove());
    },
  };
}

export async function getSmsRetrieverHash(): Promise<string | null> {
  return smsRetriever.getAppHash();
}

/** All app hashes for this install, one per signing certificate. */
export async function getSmsRetrieverHashes(): Promise<string[]> {
  return smsRetriever.getAppHashes();
}

export { startWhatsAppLogin, openWhatsApp };

// -- Auto-read internals ---------------------------------------------------

// Event is deduped; auto-submit is not, so a duplicate copy can retry after a rejected submit.
function announce(code: string): void {
  if (code !== lastAnnouncedCode) {
    lastAnnouncedCode = code;
    emit({ type: 'OTP_AUTO_READ', code });
  }
  maybeAutoSubmit(code);
}

// Replaces previous subs so resends don't stack listeners.
function listenForAutoRead(): void {
  autoReadSubs.forEach((s) => s.remove());
  // No platform check; sources return inert subs where unsupported.
  autoReadSubs = [smsRetriever.observe(announce), whatsAppOtp.observe(announce)];
}

function stopAutoRead(): void {
  autoReadSubs.forEach((s) => s.remove());
  autoReadSubs = [];
  autoSubmitEnabled = false;
  autoSubmitted = false;
  lastAnnouncedCode = null;
  // Reset ends the attempt; nothing to resend to.
  activePhone = null;
}

function maybeAutoSubmit(code: string): void {
  if (!autoSubmitEnabled || autoSubmitted) return;
  // Set before dispatch: a second copy can arrive while this submit is in flight.
  autoSubmitted = true;
  void submitOtp(code).catch(() => {
    // submitOtp already emitted ERROR; swallow to avoid an unhandled rejection.
    // Release the latch on rejection so a duplicate copy can still try.
    autoSubmitted = false;
  });
}

/** Test-only: fully reset the state machine, auto-read and device-token cache. */
export function __resetSession(): void {
  stopAutoRead();
  state = { kind: 'idle' };
  attemptCounter = 0;
  activeChannel = OtpChannel.AUTO;
  cachedDeviceToken = undefined;
}
