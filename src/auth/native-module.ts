/**
 * Shared native module for SMS Retriever and WhatsApp auto-read (same app hash).
 * Android only; returns `null` elsewhere so callers needn't check the platform.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export interface QuickAuthAutoReadNative {
  /** Start Google's SMS Retriever session and register its receiver. */
  start(): Promise<void>;
  /** Tear the SMS receiver down. */
  stop(): Promise<void>;
  /** The 11-character app hash every OTP SMS body must end with. */
  getAppHash(): Promise<string>;
  /** All app hashes for this install, one per signing certificate. */
  getAppHashes?(): Promise<string[]>;
  /** Attach to the WhatsApp receiver and flush any code it is holding. */
  startWhatsAppOtpListener?(): Promise<void>;
  stopWhatsAppOtpListener?(): Promise<void>;
  /** Broadcast Meta's `OTP_REQUESTED` handshake. Resolves to its request id. */
  sendWhatsAppOtpHandshake?(): Promise<string | null>;
  /** Drop any WhatsApp code held from an earlier attempt. */
  clearWhatsAppOtp?(): Promise<void>;
}

/** Parsed SMS code. */
export const SMS_CODE_EVENT = 'qa.sms.code';

/** WhatsApp zero-tap / one-tap code, already extracted by WhatsApp. */
export const WHATSAPP_CODE_EVENT = 'qa.whatsapp.code';

let emitter: NativeEventEmitter | null = null;

export function getNative(): QuickAuthAutoReadNative | null {
  if (Platform.OS !== 'android') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (NativeModules as any).QuickAuthSmsRetriever as
    | QuickAuthAutoReadNative
    | undefined;
  return mod ?? null;
}

export function getEmitter(): NativeEventEmitter | null {
  if (emitter) return emitter;
  const native = getNative();
  if (!native) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter = new NativeEventEmitter(native as any);
  return emitter;
}

/** Extract the code from `{ code }` or a bare string (older native builds). */
export function readCode(payload: { code?: string } | string | null | undefined): string | null {
  const code = typeof payload === 'string' ? payload : payload?.code;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Test-only: drop the cached emitter so the next call rebuilds it. */
export function __resetNativeModule(): void {
  emitter = null;
}
