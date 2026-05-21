/**
 * SMS Retriever bridge — wraps NativeModules.QuickAuthSmsRetriever.
 * iOS is a no-op; iOS uses TextInput textContentType="oneTimeCode" for autofill.
 *
 * Native module emits a `qa.sms.code` event with the parsed code when an SMS
 * containing the SDK's app-hash is received.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { OtpObserverCallback, OtpSubscription } from '../types';

interface QuickAuthSmsRetrieverNative {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAppHash(): Promise<string>;
}

let emitter: NativeEventEmitter | null = null;
let started = false;
let listenerCount = 0;

function getNative(): QuickAuthSmsRetrieverNative | null {
  if (Platform.OS !== 'android') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (NativeModules as any).QuickAuthSmsRetriever as
    | QuickAuthSmsRetrieverNative
    | undefined;
  return mod ?? null;
}

function getEmitter(): NativeEventEmitter | null {
  if (emitter) return emitter;
  const native = getNative();
  if (!native) return null;
  // Cast — NativeEventEmitter expects a NativeModule shape; we hand it the typed ref.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter = new NativeEventEmitter(native as any);
  return emitter;
}

export async function getAppHash(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.getAppHash();
  } catch {
    return null;
  }
}

export function observe(callback: OtpObserverCallback): OtpSubscription {
  if (Platform.OS !== 'android') {
    // iOS: no-op subscription. App should rely on TextInput's textContentType.
    return { remove: () => undefined };
  }
  const native = getNative();
  const ee = getEmitter();
  if (!native || !ee) {
    return { remove: () => undefined };
  }

  if (!started) {
    void native.start().catch(() => undefined);
    started = true;
  }
  listenerCount += 1;

  const sub = ee.addListener('qa.sms.code', (payload: { code?: string } | string) => {
    const code = typeof payload === 'string' ? payload : payload?.code;
    if (typeof code === 'string' && code.length > 0) callback(code);
  });

  return {
    remove: () => {
      sub.remove();
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0 && started) {
        void native.stop().catch(() => undefined);
        started = false;
      }
    },
  };
}
