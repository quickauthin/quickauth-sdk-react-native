/**
 * WhatsApp / campaign attribution. Same wire format as the Flutter and Web SDKs.
 *
 * Stores `qa_clid` from the launch link (query or fragment) and posts
 * `{ qa_clid?, fingerprint, deviceInfo }` to /v1/sdk/attribution/launch.
 * Queued until consent is granted.
 */

import { Linking } from 'react-native';
import { request } from '../core/client';
import * as consent from '../core/consent';
import * as storage from '../core/storage';
import type { AttributionResult } from '../types';
import { captureDeviceInfo } from './device-info';
import { composeFingerprint } from './fingerprint';

export const QA_CLID_KEY = 'qa.qa_clid';
export const CAMPAIGN_KEY = 'qa.campaign_id';

const NOT_MATCHED: AttributionResult = { matched: false };

let linkingSub: { remove(): void } | null = null;
let lastResult: AttributionResult | null = null;

function queryParam(qs: string, name: string): string | null {
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : '';
    try {
      if (decodeURIComponent(k) === name) {
        const value = decodeURIComponent(v.replace(/\+/g, ' '));
        return value || null;
      }
    } catch {
      /* malformed escape, skip this pair */
    }
  }
  return null;
}

/** `qa_clid` from a link's query string, falling back to its fragment. */
export function readQaClid(url: string | null | undefined): string | null {
  if (!url) return null;
  const hashIdx = url.indexOf('#');
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';
  const qIdx = beforeHash.indexOf('?');
  const fromQuery = qIdx >= 0 ? queryParam(beforeHash.slice(qIdx + 1), 'qa_clid') : null;
  if (fromQuery) return fromQuery;
  return fragment ? queryParam(fragment.replace(/^\?/, ''), 'qa_clid') : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseResult(json: unknown): AttributionResult {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const out: AttributionResult = { matched: j.matched === true };
  const qaClid = str(j.qa_clid) ?? str(j.qaClid);
  if (qaClid) out.qaClid = qaClid;
  if (str(j.campaignId)) out.campaignId = j.campaignId as string;
  if (str(j.templateId)) out.templateId = j.templateId as string;
  if (str(j.variantId)) out.variantId = j.variantId as string;
  return out;
}

async function sendLaunch(qaClid: string | null): Promise<AttributionResult> {
  const body: Record<string, unknown> = {
    fingerprint: await composeFingerprint(),
    deviceInfo: captureDeviceInfo(),
  };
  if (qaClid) body.qa_clid = qaClid;
  const json = await request({ method: 'POST', path: '/v1/sdk/attribution/launch', body });
  const result = parseResult(json);
  lastResult = result;
  try {
    if (result.qaClid) await storage.setItem(QA_CLID_KEY, result.qaClid);
    if (result.campaignId) await storage.setItem(CAMPAIGN_KEY, result.campaignId);
  } catch {
    /* noop */
  }
  return result;
}

/**
 * Attribute a launch from `url`. Never throws; resolves `{ matched: false }`
 * if consent is pending (call is queued) or the request fails.
 */
export async function capture(url: string | null | undefined): Promise<AttributionResult> {
  const qaClid = readQaClid(url);
  if (qaClid) {
    try {
      await storage.setItem(QA_CLID_KEY, qaClid);
    } catch {
      /* noop */
    }
  }

  if (!consent.get()) {
    void consent.run(async () => {
      await sendLaunch(qaClid);
    });
    return { ...NOT_MATCHED };
  }
  try {
    return await sendLaunch(qaClid);
  } catch {
    return { ...NOT_MATCHED };
  }
}

/** Attribute the link the app was opened with (or a plain launch). */
export async function captureLaunch(): Promise<AttributionResult> {
  let url: string | null = null;
  try {
    url = await Linking.getInitialURL();
  } catch {
    url = null;
  }
  return capture(url);
}

/** Attribute links received while running. Only links with `qa_clid` are sent. */
export function startLinkingListener(): { remove(): void } {
  if (linkingSub) return linkingSub;
  const handler = (event: { url: string }) => {
    if (readQaClid(event?.url)) void capture(event.url);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = (Linking as any).addEventListener?.('url', handler);
  linkingSub = {
    remove: () => {
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

/** The last launch result received from the backend in this process. */
export function getLastAttribution(): AttributionResult | null {
  return lastResult;
}

/** The stored `qa_clid`, if any link carried one. */
export async function getQaClid(): Promise<string | null> {
  try {
    return await storage.getItem(QA_CLID_KEY);
  } catch {
    return null;
  }
}

export function __reset(): void {
  lastResult = null;
  if (linkingSub) {
    try {
      linkingSub.remove();
    } catch {
      /* noop */
    }
    linkingSub = null;
  }
}
