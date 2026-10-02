/**
 * Android SMS Retriever bridge (NativeModules.QuickAuthSmsRetriever).
 * Inert on iOS, where autofill goes through `textContentType="oneTimeCode"`.
 */

import { Platform } from 'react-native';
import type { OtpObserverCallback, OtpSubscription } from '../types';
import { SMS_CODE_EVENT, getEmitter, getNative, readCode } from './native-module';

const INERT: OtpSubscription = { remove: () => undefined };

let started = false;
let listenerCount = 0;

/**
 * App hash for the running APK's signing cert; must end every OTP SMS.
 * Apps with rotated keys have several, see {@link getAppHashes}.
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

/** All app hashes for this install, one per signing certificate. */
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
 * Open a retrieval session. Sessions last 5 min and cover one message, so call
 * once per OTP request. Never rejects.
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

  // Doesn't start a session; initiate() calls start() per request.
  listenerCount += 1;

  const sub = ee.addListener(SMS_CODE_EVENT, (payload: { code?: string } | string) => {
    const code = readCode(payload);
    if (code) callback(code);
  });

  let removed = false;
  return {
    remove: () => {
      // Double remove would over-decrement and stop the retriever early.
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

/** Test-only: forget that the retriever was started. */
export function __resetSmsRetriever(): void {
  started = false;
  listenerCount = 0;
}
