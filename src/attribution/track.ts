import { request } from '../core/client';
import * as consent from '../core/consent';
import type { ConversionEvent } from '../types';
import { getQaClid } from './capture';

/**
 * Record a conversion against the stored `qa_clid`. Queued until consent is
 * granted. Best-effort: request failures are swallowed.
 */
export async function trackConversion(event: ConversionEvent): Promise<void> {
  if (!event?.event) throw new Error('[QuickAuth] event name required');

  const metadata = event.metadata ?? event.attributes;
  await consent.run(async () => {
    const qaClid = await getQaClid();
    const body: Record<string, unknown> = {
      event: event.event,
      value: event.value ?? 0,
      currency: event.currency ?? 'INR',
    };
    if (qaClid) body.qa_clid = qaClid;
    if (metadata) body.metadata = metadata;
    try {
      await request({ method: 'POST', path: '/v1/sdk/attribution/conversion', body });
    } catch {
      /* best-effort */
    }
  });
}
