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
 * All outcomes flow via `QuickAuthConfig.onAuthEvent`. The async methods
 * resolve once the network call has completed; merchants rely on the
 * event stream as the source of truth for what UI to render.
 *
 * State machine (matches web + iOS + Android + Flutter):
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

/**
 * The phone and options of the live attempt, so `resendOtp()` needs no
 * arguments.
 *
 * A merchant should not have to hold the number themselves to resend to it —
 * they already gave it to us, and asking for it again is an opportunity to
 * pass a different one, which would start a second transaction and leave the
 * user holding two codes, only one of which works.
 */
let activePhone: string | null = null;
let activeChannel: OtpChannel = OtpChannel.AUTO;

/** Whether the current attempt should verify an auto-read code by itself. */
let autoSubmitEnabled = false;

/**
 * One auto-submit per attempt.
 *
 * Both sources can deliver — a merchant sending on `auto` may get the SMS and
 * the WhatsApp copy of the same code — and submitting the second would verify
 * a code the server has already consumed, surfacing to the user as a spurious
 * failure arriving right after a success.
 */
let autoSubmitted = false;

/**
 * The last code this attempt already announced, so one code produces one
 * `OTP_AUTO_READ`.
 *
 * The SDK subscribes to both sources on the caller's behalf (see
 * {@link listenForAutoRead}) and the caller may subscribe again via
 * {@link observeOTP}; on `auto` the same code can also arrive twice, once
 * parsed from the SMS and once broadcast by WhatsApp. A merchant driving their
 * OTP field from the event would otherwise see it filled, cleared and filled
 * again. Reset per attempt, because a resend legitimately re-delivers the same
 * code and should refill the field.
 */
let lastAnnouncedCode: string | null = null;

/**
 * The SDK's own subscriptions to the auto-read sources.
 *
 * Without these, auto-read only worked for a caller who happened to call
 * `observeOTP`. A merchant who passed `autoSubmit: true` and never subscribed
 * — precisely the case where they were told they need not — got nothing at
 * all: the code arrived, was held, and was never delivered.
 */
let autoReadSubs: OtpSubscription[] = [];

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
    // The in-memory cache still holds it for this session, but OneTap will not
    // survive a cold start — and a device token that silently fails to persist
    // is exactly the failure this SDK used to ship by default. Say so.
    //
    // `silent` is read defensively: this runs on a failure path, and a config
    // that has since been torn down must not turn a storage warning into a
    // second, unrelated throw.
    let silent = false;
    try {
      silent = getConfig().silent;
    } catch {
      /* not initialised any more — report it */
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
    /* noop — nothing persisted means nothing to clear */
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

/**
 * Begin an auth attempt. Emits `OTP_SENT` (OTP delivered) or `VERIFIED`
 * (OneTap fired) via `onAuthEvent`. Rejects only on validation / transport
 * failure.
 *
 * Arms auto-read itself, so `OTP_AUTO_READ` arrives whether or not the caller
 * ever calls {@link observeOTP}. A newer attempt supersedes an older one —
 * latest wins.
 */
export async function initiate(opts: InitiateOptions): Promise<void> {
  const phone = opts?.phone;
  if (typeof phone !== 'string' || !E164.test(phone.trim())) {
    throw new Error('[QuickAuth] initiate: phone must be E.164 (e.g. +919876543210)');
  }
  const channel = opts.channel ?? OtpChannel.AUTO;
  const autoSubmit = opts.autoSubmit === true;
  const trimmed = phone.trim();
  const attemptId = ++attemptCounter;
  state = { kind: 'sending', attemptId };

  // Fire-and-forget: opening Google's retrieval session must not delay or fail
  // OTP delivery, and it is per request because the session covers one message.
  void smsRetriever.start();
  // Drop any WhatsApp code held from an earlier attempt. The manifest receiver
  // keeps one so a zero-tap code arriving before the app was running is not
  // lost, but delivering that against a request the user has since restarted
  // fails verification for reasons they cannot see.
  await whatsAppOtp.clearPending();
  // Before the OTP is requested, not after: WhatsApp checks for a live
  // handshake when it receives the template, and one sent afterwards is too
  // late for the message already in flight. Awaited for the same reason —
  // firing it without awaiting would race the send.
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

/**
 * Send the code again, to the number the current attempt is already for.
 *
 * Within the merchant's expiry window the server returns the SAME code and
 * pushes the expiry forward, so a user who missed the first message gets that
 * message again rather than a second code to choose between. Past the window
 * it issues a fresh one, which is what an expired code deserves.
 *
 * Takes no phone number deliberately — see {@link activePhone}.
 *
 * Carries the original attempt's channel and `initiate()`'s `autoSubmit`
 * setting, so a resend behaves like the request it repeats rather than
 * silently reverting to defaults. It also re-sends the WhatsApp handshake (via
 * `initiate`), since Meta expires that after ten minutes and a user who waits
 * before tapping resend would otherwise get a message their app can no longer
 * auto-read — the failure being invisible, as ever.
 *
 * Rejects if there is no attempt to resend. That is a programming error rather
 * than a runtime condition: a resend button should only exist once a code has
 * been sent.
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

/**
 * Reset the state machine and stop auto-read. Pass `forgetDevice: true` on
 * user-initiated sign-out to also drop the persistent device token, making the
 * next `initiate()` act like a brand-new install (no OneTap).
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
 * Push a code into the flow from outside — a notification listener, a paste
 * handler, a test harness, or an iOS field that received an OS autofill.
 *
 * Emits `OTP_AUTO_READ` and honours the same one-shot auto-submit latch as a
 * code the SDK read itself, so an explicitly published code cannot slip past
 * the guard that stops one code being verified twice.
 *
 * Publishing a code the SDK has already announced for this attempt does not
 * emit a second event — which is what lets `<QuickAuthOtpField>` forward an
 * iOS autofill unconditionally without the Android SMS path firing twice.
 */
export function publishAutoReadCode(code: string): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) return;
  announce(trimmed);
}

/**
 * Codes read automatically, from whichever channel delivered them (Android).
 *
 * Merges SMS and WhatsApp, because they are two delivery mechanisms for one
 * thing and a caller should not have to know which arrived. An OTP sent over
 * SMS is parsed out of the message body by the SMS Retriever; a WhatsApp
 * zero-tap or one-tap code is broadcast to the app by WhatsApp and arrives
 * already extracted. Listening to only SMS — which is all that was possible
 * before — means a merchant on `auto` gets auto-read for some users and not
 * others, with nothing to explain the difference.
 *
 * Calling this is optional: `initiate()` already subscribes on the caller's
 * behalf. The `OTP_AUTO_READ` event is emitted once per code per attempt no
 * matter how many subscriptions are live (see {@link lastAnnouncedCode}), so
 * a merchant who both handles the event and calls this does not see their
 * field filled twice.
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

/** Every app hash valid for this install — one per signing certificate. */
export async function getSmsRetrieverHashes(): Promise<string[]> {
  return smsRetriever.getAppHashes();
}

export { startWhatsAppLogin, openWhatsApp };

// -- Auto-read internals ---------------------------------------------------

/**
 * Emit `OTP_AUTO_READ` at most once per code per attempt, then auto-submit.
 *
 * The event is deduplicated but the auto-submit attempt is not gated on the
 * event: the latch in {@link maybeAutoSubmit} is the guard against verifying
 * one code twice, and it releases when a submit fails to reach the server, so
 * a second copy of the code should still be allowed to try.
 */
function announce(code: string): void {
  if (code !== lastAnnouncedCode) {
    lastAnnouncedCode = code;
    emit({ type: 'OTP_AUTO_READ', code });
  }
  maybeAutoSubmit(code);
}

/**
 * Subscribe on the caller's behalf, so a code is delivered whether or not they
 * call {@link observeOTP}.
 *
 * Idempotent across attempts: a resend must not stack subscriptions, and the
 * old ones are dropped first so a code from a previous attempt cannot arrive
 * on them.
 */
function listenForAutoRead(): void {
  autoReadSubs.forEach((s) => s.remove());
  // No platform guard. Both sources return an inert subscription where they
  // are unsupported, so subscribing off Android costs nothing — and a guard
  // reading the platform here would be a second place for "is auto-read
  // available" to be decided, which is how the two ended up disagreeing.
  autoReadSubs = [smsRetriever.observe(announce), whatsAppOtp.observe(announce)];
}

/** Stop listening. Called on reset, and safe to call twice. */
function stopAutoRead(): void {
  autoReadSubs.forEach((s) => s.remove());
  autoReadSubs = [];
  autoSubmitEnabled = false;
  autoSubmitted = false;
  lastAnnouncedCode = null;
  // Nothing left to resend to: a reset ends the attempt, and resending
  // afterwards would message someone who is no longer mid-login.
  activePhone = null;
}

function maybeAutoSubmit(code: string): void {
  if (!autoSubmitEnabled || autoSubmitted) return;
  // Claimed before dispatch, not after: submitOtp is async, and the WhatsApp
  // copy of the same code can arrive while the SMS one is still in flight.
  autoSubmitted = true;
  void submitOtp(code).catch(() => {
    // submitOtp already emitted ERROR where it got that far. There is no
    // caller to reject to, and an unhandled rejection here would surface as a
    // red box in an app that did nothing wrong.
    //
    // Release the latch. A rejection means nothing was verified — most often
    // the code beat the /initiate response back and there was no session to
    // submit against yet — and holding a latch that guards against verifying a
    // *consumed* code would then block the duplicate copy that could have
    // succeeded. A resolved submitOtp (VERIFIED or OTP_FAILED) keeps the latch
    // shut, which is the case it exists for.
    autoSubmitted = false;
  });
}

/** Test-only — fully reset the state machine, auto-read and device-token cache. */
export function __resetSession(): void {
  stopAutoRead();
  state = { kind: 'idle' };
  attemptCounter = 0;
  activeChannel = OtpChannel.AUTO;
  cachedDeviceToken = undefined;
}
