/**
 * WhatsApp zero-tap / one-tap codes (Android only; no-op elsewhere).
 * WhatsApp broadcasts the code to the app (matched on package + signing hash);
 * it never goes through the SMS Retriever.
 *
 * Auto-fill needs all of: the manifest receiver (WhatsAppOtpReceiver.java),
 * the OTP_REQUESTED handshake before each request, and `<queries>` for
 * com.whatsapp / com.whatsapp.w4b (Android 11+). All ship in the SDK.
 */

import { Platform } from 'react-native';
import type { OtpObserverCallback, OtpSubscription } from '../types';
import { WHATSAPP_CODE_EVENT, getEmitter, getNative, readCode } from './native-module';

const INERT: OtpSubscription = { remove: () => undefined };

let attached = false;
let listenerCount = 0;

function supported(): boolean {
  const native = getNative();
  // Method is missing if JS was upgraded without the native module.
  return Platform.OS === 'android' && !!native?.startWhatsAppOtpListener;
}

/**
 * Subscribe to WhatsApp codes (already extracted). The first subscriber
 * attaches the receiver, which flushes any code that arrived before JS listened.
 */
export function observe(callback: OtpObserverCallback): OtpSubscription {
  const native = getNative();
  const ee = getEmitter();
  if (!supported() || !native || !ee) return INERT;

  if (!attached) {
    void native.startWhatsAppOtpListener?.().catch(() => undefined);
    attached = true;
  }
  listenerCount += 1;

  const sub = ee.addListener(WHATSAPP_CODE_EVENT, (payload: { code?: string } | string) => {
    const code = readCode(payload);
    if (code) callback(code);
  });

  let removed = false;
  return {
    remove: () => {
      if (removed) return;
      removed = true;
      sub.remove();
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0 && attached) {
        void native.stopWhatsAppOtpListener?.().catch(() => undefined);
        attached = false;
      }
    },
  };
}

/**
 * Send Meta's OTP_REQUESTED handshake. Must precede the template send or
 * WhatsApp won't broadcast the code. Expires after 10 min, so sent per request.
 * Never rejects.
 * @returns the handshake's request id, or `null` when it could not be sent.
 */
export async function sendHandshake(): Promise<string | null> {
  const native = getNative();
  if (!supported() || !native?.sendWhatsAppOtpHandshake) return null;
  try {
    return (await native.sendWhatsAppOtpHandshake()) ?? null;
  } catch {
    return null;
  }
}

/** Discard any code the receiver is holding from an earlier attempt. */
export async function clearPending(): Promise<void> {
  const native = getNative();
  if (!supported() || !native?.clearWhatsAppOtp) return;
  try {
    await native.clearWhatsAppOtp();
  } catch {
    /* Older native build without the method holds nothing to clear. */
  }
}

/** Test-only: forget that the receiver bridge was attached. */
export function __resetWhatsAppOtp(): void {
  attached = false;
  listenerCount = 0;
}
