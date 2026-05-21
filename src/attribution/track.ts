import { request } from '../core/client';
import * as consent from '../core/consent';
import type { ConversionEvent } from '../types';
import { getLastAttribution } from './capture';

export async function trackConversion(event: ConversionEvent): Promise<void> {
  if (!event?.event) throw new Error('[QuickAuth] event name required');
  if (!consent.get()) return; // silent drop — DPDP/GDPR

  const attribution = getLastAttribution();
  try {
    await request({
      method: 'POST',
      path: '/v1/sdk/attribution/conversion',
      body: {
        event: event.event,
        value: event.value ?? 0,
        currency: event.currency ?? 'INR',
        attributes: event.attributes ?? {},
        attribution,
        occurred_at: new Date().toISOString(),
      },
    });
  } catch {
    /* swallow — best-effort */
  }
}
