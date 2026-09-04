/**
 * SMS Retriever bridge — wraps NativeModules.QuickAuthSmsRetriever.
 *
 * Android only. iOS auto-fill is the OS dropping the code into a field marked
 * `textContentType="oneTimeCode"`; the SDK is never told the code, so there is
 * nothing to bridge and every function here is inert.
 *
 * The native module emits `qa.sms.code` carrying the code it parsed out of a
 * message body ending in this app's 11-character app hash.
 */

import { Platform } from 'react-native';
import type { OtpObserverCallback, OtpSubscription } from '../types';
import { SMS_CODE_EVENT, getEmitter, getNative, readCode } from './native-module';

const INERT: OtpSubscription = { remove: () => undefined };

let started = false;
let listenerCount = 0;

/**
 * The app hash that must terminate every OTP SMS body.
 *
 * Returns the hash for the certificate that signed the running APK. An app
 * that has rotated its signing key (v3) has more than one and needs all of
 * them registered with the sender — see {@link getAppHashes}.
 */
export async function getAppHash(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.getAppHash();
  } catch {
    return null;
  }
}

/** Every app hash valid for this install — one per signing certificate. */
export async function getAppHashes(): Promise<string[]> {
  const native = getNative();
  if (!native?.getAppHashes) return [];
  try {
    return (await native.getAppHashes()) ?? [];
  } catch {
    return [];
  }
}

/**
 * Open a retrieval session.
 *
 * Google's session lasts five minutes and covers one message, so it is started
 * per OTP request rather than once. {@link observe} starts one lazily for a
 * caller who only subscribes, but a resend while another subscription is
 * already live would otherwise inherit the first request's session — which may
 * have expired while the user waited before tapping "resend", losing auto-read
 * for exactly the message they asked for again.
 *
 * Never rejects: a retriever failure costs auto-read, not the login.
 */
export async function start(): Promise<boolean> {
  const native = getNative();
  if (Platform.OS !== 'android' || !native) return false;
  try {
    await native.start();
    started = true;
    return true;
  } catch {
    return false;
  }
}

export function observe(callback: OtpObserverCallback): OtpSubscription {
  const native = getNative();
  const ee = getEmitter();
  if (Platform.OS !== 'android' || !native || !ee) return INERT;

  // Deliberately does not open a session. `initiate()` calls {@link start} for
  // every request, which is where a session belongs — one per OTP. Starting
  // here as well produced two `startSmsRetriever` calls per request, and left a
  // subscriber who never requested an OTP holding a session for nothing.
  listenerCount += 1;

  const sub = ee.addListener(SMS_CODE_EVENT, (payload: { code?: string } | string) => {
    const code = readCode(payload);
    if (code) callback(code);
  });

  let removed = false;
  return {
    remove: () => {
      // Guard against a double remove: two decrements for one subscription
      // would stop the retriever while another listener was still using it.
      if (removed) return;
      removed = true;
      sub.remove();
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0 && started) {
        void native.stop().catch(() => undefined);
        started = false;
      }
    },
  };
}

/** Test-only — forget that the retriever was started. */
export function __resetSmsRetriever(): void {
  started = false;
  listenerCount = 0;
}
