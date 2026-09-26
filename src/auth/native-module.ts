/**
 * The single native module behind both auto-read sources.
 *
 * SMS Retriever and WhatsApp zero-tap are two delivery mechanisms for one
 * thing, and they share a native module for the same reason the Flutter
 * plugin shares one method channel: the app hash they are matched on is the
 * same value, and splitting them was how the two ended up disagreeing about
 * whether auto-read was available at all.
 *
 * Everything here is Android-only and returns `null` elsewhere, so callers
 * subscribe unconditionally instead of branching on the platform — a second
 * place to decide "is auto-read supported" is a second place for it to be
 * wrong.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export interface QuickAuthAutoReadNative {
  /** Start Google's SMS Retriever session and register its receiver. */
  start(): Promise<void>;
  /** Tear the SMS receiver down. */
  stop(): Promise<void>;
  /** The 11-character app hash every OTP SMS body must end with. */
  getAppHash(): Promise<string>;
  /** Every app hash valid for this install — one per signing certificate. */
  getAppHashes?(): Promise<string[]>;
  /**
   * Attach to the manifest-declared WhatsApp receiver and flush any code it
   * is holding from before JS was listening.
   */
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
  // Cast — NativeEventEmitter expects a NativeModule shape; we hand it the typed ref.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter = new NativeEventEmitter(native as any);
  return emitter;
}

/**
 * Pull a code out of an event payload.
 *
 * Both events carry `{ code, … }`; older native builds emitted a bare string.
 */
export function readCode(payload: { code?: string } | string | null | undefined): string | null {
  const code = typeof payload === 'string' ? payload : payload?.code;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Test-only — drop the cached emitter so the next call rebuilds it. */
export function __resetNativeModule(): void {
  emitter = null;
}
