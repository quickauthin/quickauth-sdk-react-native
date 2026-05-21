import { Linking } from 'react-native';
import type { WhatsAppLoginParams } from '../types';

function normalize(num: string): string {
  return num.replace(/[^\d]/g, '');
}

export async function startWhatsAppLogin(params: WhatsAppLoginParams): Promise<void> {
  const number = normalize(params.businessNumber);
  if (!number) {
    throw new Error('[QuickAuth] businessNumber required');
  }
  const text = encodeURIComponent(params.message ?? 'Login');
  const url = `https://wa.me/${number}?text=${text}`;
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    throw new Error('[QuickAuth] WhatsApp not installed or URL scheme blocked');
  }
  await Linking.openURL(url);
}
