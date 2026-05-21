import { request } from '../core/client';
import {
  OtpChannel,
  type OtpObserverCallback,
  type OtpSession,
  type OtpStartParams,
  type OtpSubscription,
  type OtpVerifyParams,
  type OtpVerifyResult,
} from '../types';
import * as smsRetriever from './sms-retriever';
import { startWhatsAppLogin } from './whatsapp';

interface InitiateResponse {
  session_id: string;
  channel: OtpChannel | string;
  expires_at: string;
  sms_retriever_hash?: string;
}

interface VerifyResponse {
  success: boolean;
  jwt?: string;
  user_id?: string;
  phone?: string;
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed.startsWith('+')) {
    throw new Error('[QuickAuth] phone must be E.164 (start with +countrycode)');
  }
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    throw new Error('[QuickAuth] phone is not valid E.164');
  }
  return trimmed;
}

export async function startOTP(params: OtpStartParams): Promise<OtpSession> {
  const phone = normalizePhone(params.phone);
  const channel = params.channel ?? OtpChannel.AUTO;
  const res = await request<InitiateResponse>({
    method: 'POST',
    path: '/v1/sdk/auth/initiate',
    body: {
      phone,
      channel,
      locale: params.locale,
      metadata: params.metadata,
    },
  });
  return {
    sessionId: res.session_id,
    channel: (res.channel as OtpChannel) ?? channel,
    expiresAt: res.expires_at,
    smsRetrieverHash: res.sms_retriever_hash,
  };
}

export async function verifyOTP(params: OtpVerifyParams): Promise<OtpVerifyResult> {
  if (!params?.sessionId) throw new Error('[QuickAuth] sessionId required');
  if (!params?.code || !/^\d{4,8}$/.test(params.code)) {
    throw new Error('[QuickAuth] code must be 4-8 digits');
  }
  const res = await request<VerifyResponse>({
    method: 'POST',
    path: '/v1/sdk/auth/verify',
    body: { session_id: params.sessionId, code: params.code },
  });
  return {
    success: !!res.success,
    jwt: res.jwt,
    userId: res.user_id,
    phone: res.phone,
  };
}

export function observeOTP(callback: OtpObserverCallback): OtpSubscription {
  return smsRetriever.observe(callback);
}

export async function getSmsRetrieverHash(): Promise<string | null> {
  return smsRetriever.getAppHash();
}

export { startWhatsAppLogin };
