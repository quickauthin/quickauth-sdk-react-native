/**
 * WhatsApp zero-tap / one-tap authentication codes.
 *
 * WhatsApp does not send these over SMS. It broadcasts the code to the app
 * named in the template's `supported_apps`, matched on package name and the
 * 11-character signing hash, so Google's SMS Retriever never sees the message.
 * Before this existed the code was dropped on the floor: a merchant sending on
 * `whatsapp` got no auto-read at all, and one sending on `auto` got it for the
 * users the backend happened to route over SMS and not for the rest, with
 * nothing to explain the difference.
 *
 * Four things have to be true together for a WhatsApp code to auto-fill, and
 * with any one missing the symptom is identical — the message arrives, the
 * code does not fill, nothing errors:
 *
 *   1. a manifest-declared receiver, so the broadcast lands even when the app
 *      is backgrounded or not running (WhatsAppOtpReceiver.java);
 *   2. the `OTP_REQUESTED` handshake below, sent *before* each OTP request;
 *   3. `<queries>` for `com.whatsapp` / `com.whatsapp.w4b`, so Android 11+
 *      actually delivers that handshake;
 *   4. the OTP service merging this source with SMS rather than picking one.
 *
 * All four ship in the SDK. Merchants declare nothing.
 *
 * Android only — zero-tap and one-tap are Android features. Everything here
 * is a no-op elsewhere.
 */

import { Platform } from 'react-native';
import type { OtpObserverCallback, OtpSubscription } from '../types';
import { WHATSAPP_CODE_EVENT, getEmitter, getNative, readCode } from './native-module';

const INERT: OtpSubscription = { remove: () => undefined };

let attached = false;
let listenerCount = 0;

function supported(): boolean {
  const native = getNative();
  // `startWhatsAppOtpListener` is absent on an app that upgraded the JS but
  // not the native module. Treating that as "unsupported" is the same shape
  // as a device with no WhatsApp installed, which every caller already
  // handles.
  return Platform.OS === 'android' && !!native?.startWhatsAppOtpListener;
}

/**
 * Codes as WhatsApp delivers them — already the code, not a message to parse.
 *
 * Subscribing attaches to the manifest receiver, which immediately flushes
 * anything that arrived while nothing was listening. That matters more here
 * than on the SMS path: the entire point of zero-tap is that the code can
 * arrive before the user has opened the app.
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
 * Tell WhatsApp a code is about to be requested, and that this app may
 * receive it.
 *
 * Zero-tap does not work without this, and nothing says so. Meta requires the
 * handshake BEFORE the template is sent: without it WhatsApp receives the
 * message, shows it, and simply never broadcasts the code. Every other check
 * can pass — template approved, package matching, signing hash matching,
 * receiver declared and firing — and the OTP still does not auto-fill.
 *
 * The handshake expires after ten minutes, which is why it goes per request
 * rather than once at startup, and why `resendOtp()` re-sends it.
 *
 * Never rejects: a missing handshake costs auto-read, not the login.
 *
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

/**
 * Discard any code the receiver is holding from an earlier attempt.
 *
 * Without this, a code that arrived after the user gave up on a previous
 * attempt would be delivered against the new request and fail verification
 * for reasons they cannot see.
 */
export async function clearPending(): Promise<void> {
  const native = getNative();
  if (!supported() || !native?.clearWhatsAppOtp) return;
  try {
    await native.clearWhatsAppOtp();
  } catch {
    /* Older native build without the method holds nothing to clear. */
  }
}

/** Test-only — forget that the receiver bridge was attached. */
export function __resetWhatsAppOtp(): void {
  attached = false;
  listenerCount = 0;
}
