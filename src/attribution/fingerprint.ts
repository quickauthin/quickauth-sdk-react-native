import { Dimensions, PixelRatio } from 'react-native';
import { getFingerprint } from './device-info';
import * as storage from '../core/storage';
import type { DeviceFingerprint, LaunchFingerprint } from '../types';

/** Coarse device snapshot. See {@link getFingerprint}. */
export function fingerprint(): DeviceFingerprint {
  return getFingerprint();
}

/** 32-bit FNV-1a of the coarse snapshot. */
export function fingerprintHash(fp: DeviceFingerprint): string {
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

export const ANCHOR_KEY = 'qa.fingerprint_anchor';

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

/** A random id generated once per install and kept in storage. */
async function anchor(): Promise<string> {
  try {
    const existing = await storage.getItem(ANCHOR_KEY);
    if (existing) return existing;
  } catch {
    /* fall through; a fresh anchor still works for this launch */
  }
  const fresh = randomHex(32);
  try {
    await storage.setItem(ANCHOR_KEY, fresh);
  } catch {
    /* noop */
  }
  return fresh;
}

function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
  }
  return out;
}

/** 64-bit FNV-1a (matches Flutter SDK), computed in 16-bit limbs to avoid BigInt. */
export function fnv1a64(input: string): string {
  // Offset basis 0xcbf29ce484222325, low limb first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const byte of utf8Bytes(input)) {
    h0 ^= byte;
    // Multiply by the prime 0x100000001b3 = 2^40 + 0x1b3.
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + h0 * 0x100;
    const t3 = h3 * 0x1b3 + h1 * 0x100;
    t1 += t0 >>> 16;
    t2 += Math.floor(t1 / 0x10000);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h3 = (t3 + Math.floor(t2 / 0x10000)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

/**
 * Fingerprint for /v1/sdk/attribution/launch (Flutter SDK shape): per-install
 * anchor plus coarse device traits. Screen size is in physical pixels.
 */
export async function composeFingerprint(): Promise<LaunchFingerprint> {
  const fp = getFingerprint();
  let screenW: number | null = null;
  let screenH: number | null = null;
  let dpr: number | null = null;
  try {
    const { width, height } = Dimensions.get('screen');
    dpr = PixelRatio.get();
    screenW = Math.round(width * dpr);
    screenH = Math.round(height * dpr);
  } catch {
    /* noop */
  }
  const raw = {
    anchor: await anchor(),
    locale: (fp.locale ?? 'und').replace(/_/g, '-'),
    tz: -new Date().getTimezoneOffset(),
    screenW,
    screenH,
    dpr,
  };
  return { ...raw, hash: fnv1a64(JSON.stringify(raw)) };
}
