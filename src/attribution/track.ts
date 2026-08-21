import { request } from '../core/client';
import * as consent from '../core/consent';
import type { ConversionEvent } from '../types';
import { getLastAttribution } from './capture';
import { fingerprintHash } from './fingerprint';

export async function trackConversion(event: ConversionEvent): Promise<void> {
  if (!event?.event) throw new Error('[QuickAuth] event name required');
  if (!consent.get()) return; // silent drop — DPDP/GDPR

  const captured = getLastAttribution();
  // The backend dedupes conversions on `fingerprint.hash`; sending the raw
  // fingerprint without it leaves every conversion looking like a new device.
  const attribution = captured
    ? {
        ...captured,
        fingerprint: {
          ...captured.fingerprint,
          hash: fingerprintHash(captured.fingerprint),
        },
      }
    : null;

  try {
    await request({
      method: 'POST',
      path: '/v1/sdk/attribution/conversion',
      body: {
        event: event.event,
        value: event.value ?? 0,
        currency: event.currency ?? 'INR',
        // Wire name is `metadata` — the backend binds nothing off `attributes`.
        metadata: event.attributes ?? {},
        attribution,
        occurred_at: new Date().toISOString(),
      },
    });
  } catch {
    /* swallow — best-effort */
  }
}
