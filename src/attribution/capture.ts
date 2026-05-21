import { Linking } from 'react-native';
import { request } from '../core/client';
import * as consent from '../core/consent';
import * as storage from '../core/storage';
import type { AttributionPayload } from '../types';
import { fingerprint } from './fingerprint';

const STORAGE_KEY = 'qa.attribution';

const UTM_KEYS: Array<[keyof AttributionPayload, string]> = [
  ['source', 'utm_source'],
  ['medium', 'utm_medium'],
  ['campaign', 'utm_campaign'],
  ['content', 'utm_content'],
  ['term', 'utm_term'],
];

const CLICK_KEYS = ['qa_click_id', 'click_id', 'gclid', 'fbclid', 'ttclid'];

export function parseLaunchUrl(url: string | null | undefined): Partial<AttributionPayload> {
  if (!url) return {};
  let parsedQuery: Record<string, string> = {};
  try {
    // RN Linking URLs may include custom schemes — split manually.
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      const qs = url.slice(qIdx + 1).split('#')[0];
      qs.split('&').forEach((pair) => {
        if (!pair) return;
        const [k, v] = pair.split('=');
        if (k) parsedQuery[decodeURIComponent(k)] = decodeURIComponent((v ?? '').replace(/\+/g, ' '));
      });
    }
  } catch {
    parsedQuery = {};
  }

  const out: Partial<AttributionPayload> = { launchUrl: url };
  UTM_KEYS.forEach(([target, src]) => {
    if (parsedQuery[src]) (out as Record<string, unknown>)[target as string] = parsedQuery[src];
  });
  for (const k of CLICK_KEYS) {
    if (parsedQuery[k]) {
      out.clickId = parsedQuery[k];
      break;
    }
  }
  return out;
}

let linkingSub: { remove(): void } | null = null;
let lastCaptured: AttributionPayload | null = null;

export async function captureLaunch(): Promise<AttributionPayload> {
  let url: string | null = null;
  try {
    url = await Linking.getInitialURL();
  } catch {
    url = null;
  }
  return capture(url);
}

export async function capture(url: string | null | undefined): Promise<AttributionPayload> {
  const fp = fingerprint();
  const parsed = parseLaunchUrl(url);
  const payload: AttributionPayload = {
    fingerprint: fp,
    capturedAt: new Date().toISOString(),
    ...parsed,
  };

  lastCaptured = payload;

  try {
    await storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* noop */
  }

  if (consent.get()) {
    try {
      await request({
        method: 'POST',
        path: '/v1/sdk/attribution/launch',
        body: payload,
      });
    } catch {
      /* swallow — attribution is best-effort */
    }
  }
  return payload;
}

/**
 * Subscribe to subsequent deep links opened while the app is foregrounded.
 * Auto-called by init().
 */
export function startLinkingListener(): { remove(): void } {
  if (linkingSub) return linkingSub;
  const handler = (event: { url: string }) => {
    void capture(event.url);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = (Linking as any).addEventListener?.('url', handler);
  linkingSub = {
    remove: () => {
      // RN <0.65 returned void from addEventListener; >=0.65 returns subscription
      if (sub && typeof sub.remove === 'function') {
        sub.remove();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Linking as any).removeEventListener?.('url', handler);
      }
      linkingSub = null;
    },
  };
  return linkingSub;
}

export function getLastAttribution(): AttributionPayload | null {
  return lastCaptured;
}

/** Test-only. */
export function __reset(): void {
  lastCaptured = null;
  if (linkingSub) {
    linkingSub.remove();
    linkingSub = null;
  }
}
