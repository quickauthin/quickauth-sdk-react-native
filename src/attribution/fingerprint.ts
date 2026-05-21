/**
 * Lightweight, deterministic-ish fingerprint built from device dimensions,
 * platform, locale and timezone. NOT a precise identifier — just a coarse
 * signal to help dedupe attribution events when the same install opens
 * multiple deep links in a session.
 */

import { getFingerprint } from './device-info';
import type { DeviceFingerprint } from '../types';

export function fingerprint(): DeviceFingerprint {
  return getFingerprint();
}

export function fingerprintHash(fp: DeviceFingerprint): string {
  // Tiny FNV-1a 32-bit. Stable across invocations on same device.
  const str = [
    fp.platform,
    fp.osVersion ?? '',
    fp.screenWidth ?? 0,
    fp.screenHeight ?? 0,
    fp.pixelRatio ?? 0,
    fp.timezone ?? '',
    fp.locale ?? '',
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}
