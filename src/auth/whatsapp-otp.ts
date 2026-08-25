/**
 * WhatsApp zero-tap / one-tap OTP bridge.
 *
 * WhatsApp does not send these over SMS. It broadcasts the code to the app named in the
 * template's `supported_apps`, matched on package name and the 11-character signing hash, so
 * the SMS Retriever never sees it — the two are different delivery channels that happen to
 * share the same app hash.
 *
 * Android only. Zero-tap and one-tap are Android features; everywhere else these are no-ops,
 * so callers can use them unconditionally rather than branching on the platform.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { OtpObserverCallback, OtpSubscription } from '../types';

/** WhatsApp codes travel on their own event, not on the SMS one. */
const WA_EVENT = 'qa.whatsapp.code';

interface QuickAuthWhatsAppNative {
  startWhatsAppOtp(): Promise<boolean>;
  stopWhatsAppOtp(): Promise<boolean>;
  clearWhatsAppOtp(): Promise<boolean>;
  sendWhatsAppOtpHandshake(): Promise<string | null>;
}

let emitter: NativeEventEmitter | null = null;

/**
 * The native module, but only if it actually carries the WhatsApp methods.
 *
 * A React Native app can run a newer JS bundle against an older native build — that is the
 * normal state of affairs with over-the-air updates — and calling a method that build does not
 * have throws, taking down the OTP screen rather than merely losing auto-read. Feature-detect
 * instead of assuming, so an app that has not rebuilt its native side simply gets SMS
 * auto-read and no WhatsApp, which is the behaviour it had before this existed.
 */
function getNative(): QuickAuthWhatsAppNative | null {
  if (Platform.OS !== 'android') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (NativeModules as any).QuickAuthSmsRetriever as
    | Partial<QuickAuthWhatsAppNative>
    | undefined;
  if (!mod || typeof mod.startWhatsAppOtp !== 'function') return null;
  return mod as QuickAuthWhatsAppNative;
}

function getEmitter(): NativeEventEmitter | null {
  if (emitter) return emitter;
  const native = getNative();
  if (!native) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter = new NativeEventEmitter(native as any);
  return emitter;
}

/**
 * Tell WhatsApp a code is about to be requested, and that this app may receive it.
 *
 * Meta requires this BEFORE the template is sent; without it WhatsApp shows the message and
 * never broadcasts the code, with every other check passing and nothing to explain it. Expires
 * after ten minutes, so it goes per request rather than once at startup.
 *
 * Never throws: a missing handshake costs auto-read, not the login.
 */
export async function sendHandshake(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.sendWhatsAppOtpHandshake();
  } catch {
    return null;
  }
}

/**
 * Discard any code held natively from an earlier attempt.
 *
 * Delivering one against a request the user has since restarted fails verification for reasons
 * they cannot see.
 */
export async function clearPending(): Promise<void> {
  const native = getNative();
  if (!native) return;
  try {
    await native.clearWhatsAppOtp();
  } catch {
    // Older native build without the method. Nothing is held there either, so failing here
    // would break a call that has nothing to do.
  }
}

/** Codes as WhatsApp delivers them — already the code, not a message to parse. */
export function observe(callback: OtpObserverCallback): OtpSubscription {
  const native = getNative();
  const ee = getEmitter();
  if (!native || !ee) return { remove: () => undefined };

  // Attaching also flushes anything caught while JS was not running.
  void native.startWhatsAppOtp().catch(() => undefined);

  const sub = ee.addListener(WA_EVENT, (payload: { code?: string } | string) => {
    const code = typeof payload === 'string' ? payload : payload?.code;
    if (typeof code === 'string' && code.length > 0) callback(code);
  });

  return {
    remove: () => {
      sub.remove();
      // Detach natively too, or the receiver keeps a reference to a dead callback.
      void native.stopWhatsAppOtp().catch(() => undefined);
    },
  };
}
