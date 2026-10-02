import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import * as consent from '../src/core/consent';
import { __resetStorage, createMemoryStorage, setStorageAdapter } from '../src/core/storage';
import {
  __reset as resetCapture,
  capture,
  captureLaunch,
  readQaClid,
  getLastAttribution,
  getQaClid,
  startLinkingListener,
} from '../src/attribution/capture';
import { trackConversion } from '../src/attribution/track';
import {
  composeFingerprint,
  fingerprint,
  fingerprintHash,
  fnv1a64,
} from '../src/attribution/fingerprint';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function respond(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
  });
}

const sentBody = (i = 0) => JSON.parse(global.fetch.mock.calls[i][1].body);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('attribution — Flutter / Web wire format', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    setConfig({ onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600) });
    consent.__reset();
    __resetStorage();
    setStorageAdapter(createMemoryStorage());
    resetCapture();
    RN.__testHelpers.setPlatform('android');
    RN.__testHelpers.setInitialUrl(null);
    respond({ matched: false });
  });

  it('reads qa_clid from the query string, then the fragment', () => {
    expect(readQaClid('myapp://open?utm_source=wa&qa_clid=clid_1')).toBe('clid_1');
    expect(readQaClid('https://x.in/l#qa_clid=clid_2&y=1')).toBe('clid_2');
    expect(readQaClid('https://x.in/l?qa_clid=q#qa_clid=f')).toBe('q');
    expect(readQaClid('https://x.in/l?gclid=abc')).toBeNull();
    expect(readQaClid(null)).toBeNull();
  });

  it('posts { qa_clid, fingerprint, deviceInfo } and returns the backend result', async () => {
    consent.set(true);
    respond({ matched: true, qa_clid: 'clid_9', campaignId: 'cmp_1', templateId: 't1', variantId: 'v2' });

    const result = await capture('myapp://open?qa_clid=clid_9');

    expect(global.fetch.mock.calls[0][0]).toContain('/v1/sdk/attribution/launch');
    const body = sentBody();
    expect(body.qa_clid).toBe('clid_9');
    expect(body.fingerprint).toMatchObject({ locale: 'en-US', screenW: 1170, screenH: 2532, dpr: 3 });
    expect(body.fingerprint.anchor).toMatch(/^[0-9a-f]{32}$/);
    expect(body.fingerprint.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.deviceInfo).toMatchObject({ platform: 'android', sdk: expect.stringMatching(/^react-native\//) });
    expect(result).toEqual({ matched: true, qaClid: 'clid_9', campaignId: 'cmp_1', templateId: 't1', variantId: 'v2' });
    expect(getLastAttribution()).toEqual(result);
    expect(await getQaClid()).toBe('clid_9');
  });

  it('sends no qa_clid for a plain launch', async () => {
    consent.set(true);
    await captureLaunch();
    expect(sentBody().qa_clid).toBeUndefined();
  });

  it('queues the launch until consent is granted, then sends it', async () => {
    RN.__testHelpers.setInitialUrl('myapp://?qa_clid=clid_q');
    const result = await captureLaunch();
    expect(result).toEqual({ matched: false });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(consent.pendingCount()).toBe(1);
    expect(await getQaClid()).toBe('clid_q'); // kept for later

    await consent.set(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody().qa_clid).toBe('clid_q');
  });

  it('the anchor is stable across launches', async () => {
    consent.set(true);
    const a = await composeFingerprint();
    const b = await composeFingerprint();
    expect(a.anchor).toBe(b.anchor);
    expect(a.hash).toBe(b.hash);
  });

  it('a failed launch resolves { matched: false } instead of throwing', async () => {
    consent.set(true);
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    setConfig({ onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600), maxRetries: 0 });
    await expect(capture('myapp://?qa_clid=x')).resolves.toEqual({ matched: false });
  });

  it('the linking listener attributes only links that carry qa_clid', async () => {
    consent.set(true);
    startLinkingListener();
    RN.Linking.__emitUrl('myapp://settings');
    await settle();
    expect(global.fetch).not.toHaveBeenCalled();

    RN.Linking.__emitUrl('myapp://promo?qa_clid=clid_live');
    await settle();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody().qa_clid).toBe('clid_live');
  });

  it('trackConversion sends { event, value, currency, qa_clid, metadata }', async () => {
    consent.set(true);
    await capture('myapp://?qa_clid=clid_c');
    global.fetch.mockClear();

    await trackConversion({ event: 'purchase', value: 499, metadata: { sku: 'A1' } });

    expect(global.fetch.mock.calls[0][0]).toContain('/v1/sdk/attribution/conversion');
    expect(sentBody()).toEqual({
      event: 'purchase',
      value: 499,
      currency: 'INR',
      qa_clid: 'clid_c',
      metadata: { sku: 'A1' },
    });
  });

  it('trackConversion maps the deprecated attributes to metadata', async () => {
    consent.set(true);
    await trackConversion({ event: 'signup', attributes: { plan: 'pro' } });
    expect(sentBody().metadata).toEqual({ plan: 'pro' });
    expect(sentBody().attributes).toBeUndefined();
  });

  it('fingerprint() returns platform + screen dims', () => {
    const fp = fingerprint();
    expect(fp.platform).toBe('android');
    expect(fp.screenWidth).toBe(390);
    expect(fp.screenHeight).toBe(844);
    expect(fingerprintHash(fp)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('fnv1a64 matches a BigInt reference implementation', () => {
    const ref = (s: string) => {
      let h = BigInt('0xcbf29ce484222325');
      for (const b of Buffer.from(s, 'utf8')) {
        h ^= BigInt(b);
        h = (h * BigInt('0x100000001b3')) & BigInt('0xffffffffffffffff');
      }
      return h.toString(16).padStart(16, '0');
    };
    for (const s of ['', 'a', 'hello world', '{"anchor":"x","locale":"en-IN","tz":330}', 'ünïcødé 🚀']) {
      expect(fnv1a64(s)).toBe(ref(s));
    }
  });
});
