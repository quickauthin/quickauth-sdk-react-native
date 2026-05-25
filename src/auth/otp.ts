/**
 * Headless auth state machine.
 *
 * Public API:
 *   QuickAuth.auth.initiate({ phone, channel })
 *   QuickAuth.auth.submitOtp(code)
 *   QuickAuth.auth.reset({ forgetDevice })
 *
 * All outcomes flow via `QuickAuthConfig.onAuthEvent`. The async methods
 * resolve once the network call has completed; merchants rely on the
 * event stream as the source of truth for what UI to render.
 *
 * State machine (matches web + iOS + Android):
 *   idle → sending → awaiting_otp → verifying → verified
 *                  └ verified                 └ awaiting_otp (retry on OTP_FAILED)
 *                  └ failed
 *
 * Concurrent `initiate()` calls follow latest-wins semantics.
 */

import { request } from '../core/client';
import { getConfig } from '../core/config';
import * as storage from '../core/storage';
import {
  OtpChannel,
  type AuthEvent,
  type InitiateOptions,
  type OtpObserverCallback,
  type OtpSubscription,
  type ResetOptions,
} from '../types';
import * as smsRetriever from './sms-retriever';
import { startWhatsAppLogin } from './whatsapp';

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
  } catch {
    /* AsyncStorage failure — in-memory cache still holds it for this session */
  }
}

async function clearDeviceToken(): Promise<void> {
  cachedDeviceToken = null;
  try {
    await storage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* noop */
  }
}

function emit(event: AuthEvent): void {
  const handler = getConfig().onAuthEvent;
  if (!handler) return;
  // Microtask defer keeps event delivery off the synchronous resolution
  // path of the awaited promise.
  Promise.resolve().then(() => {
    try {
      handler(event);
    } catch (err) {
      // Don't let merchant handler bugs crash the SDK.
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

function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  return typeof e?.message === 'string' ? e.message : 'Request failed';
}

export async function initiate(opts: InitiateOptions): Promise<void> {
  const phone = opts?.phone;
  if (typeof phone !== 'string' || !E164.test(phone.trim())) {
    throw new Error('[QuickAuth] initiate: phone must be E.164 (e.g. +919876543210)');
  }
  const channel = opts.channel ?? OtpChannel.AUTO;
  const attemptId = ++attemptCounter;
  state = { kind: 'sending', attemptId };

  const deviceToken = await loadDeviceToken();
  const body: Record<string, unknown> = {
    phone: phone.trim(),
    channel,
  };
  if (deviceToken) body.deviceToken = deviceToken;

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
      emit({ type: 'ERROR', code: classifyError(err), message: errorMessage(err) });
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
    expiresIn: res.expiresIn,
  });
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
      emit({ type: 'ERROR', code: classifyError(err), message: errorMessage(err) });
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

export async function reset(opts?: ResetOptions): Promise<void> {
  state = { kind: 'idle' };
  attemptCounter++;
  if (opts?.forgetDevice) {
    await clearDeviceToken();
  }
}

export function observeOTP(callback: OtpObserverCallback): OtpSubscription {
  return smsRetriever.observe((code: string) => {
    callback(code);
    emit({ type: 'OTP_AUTO_READ', code });
  });
}

export async function getSmsRetrieverHash(): Promise<string | null> {
  return smsRetriever.getAppHash();
}

export { startWhatsAppLogin };

/** Test-only — fully reset the state machine and device-token cache. */
export function __resetSession(): void {
  state = { kind: 'idle' };
  attemptCounter = 0;
  cachedDeviceToken = undefined;
}
