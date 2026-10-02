/**
 * Click-to-WhatsApp login: opens a chat with the business number and a
 * prefilled message. Unrelated to OTP auto-read (see `whatsapp-otp.ts`).
 */

import { Linking } from 'react-native';
import type { WhatsAppLoginParams } from '../types';

function normalize(num: string): string {
  return num.replace(/[^\d]/g, '');
}

function buildUrl(params: WhatsAppLoginParams): string {
  const number = normalize(params.businessNumber);
  if (!number) {
    throw new Error('[QuickAuth] businessNumber required');
  }
  const text = encodeURIComponent(params.message ?? 'Login');
  return `https://wa.me/${number}?text=${text}`;
}

/**
 * Open a WhatsApp chat with the business number.
 * @returns `false` if WhatsApp can't be opened (fall back to SMS). Throws on an invalid number.
 */
export async function openWhatsApp(params: WhatsAppLoginParams): Promise<boolean> {
  const url = buildUrl(params);
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) return false;
  await Linking.openURL(url);
  return true;
}

/**
 * Like {@link openWhatsApp} but throws when WhatsApp can't be opened. Kept for 1.x callers.
 */
export async function startWhatsAppLogin(params: WhatsAppLoginParams): Promise<void> {
  const opened = await openWhatsApp(params);
  if (!opened) {
    throw new Error('[QuickAuth] WhatsApp not installed or URL scheme blocked');
  }
}
