/**
 * Click-to-WhatsApp login — opens a chat with the merchant's business number
 * and a prefilled message, which the merchant's WhatsApp Business API side
 * turns into an authenticated session.
 *
 * Unrelated to WhatsApp OTP auto-read (see `whatsapp-otp.ts`), which is how a
 * code sent over WhatsApp reaches the app.
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
 * Open WhatsApp, or report that it could not be opened.
 *
 * Returns `false` rather than throwing when WhatsApp is not installed. A user
 * without WhatsApp is an ordinary condition — the merchant should fall back to
 * SMS — not an exception, and a throw on that path pushed every caller into a
 * try/catch that could not tell "not installed" from "you passed a bad
 * number". A bad number still throws, because that one is the caller's bug.
 */
export async function openWhatsApp(params: WhatsAppLoginParams): Promise<boolean> {
  const url = buildUrl(params);
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) return false;
  await Linking.openURL(url);
  return true;
}

/**
 * Open WhatsApp, throwing when it is not installed.
 *
 * Kept for callers written against 1.x. New code should prefer
 * {@link openWhatsApp}.
 */
export async function startWhatsAppLogin(params: WhatsAppLoginParams): Promise<void> {
  const opened = await openWhatsApp(params);
  if (!opened) {
    throw new Error('[QuickAuth] WhatsApp not installed or URL scheme blocked');
  }
}
