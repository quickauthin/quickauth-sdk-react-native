import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import * as consent from '../src/core/consent';
import { __resetStorage } from '../src/core/storage';
import {
  __reset as resetCapture,
  capture,
  captureLaunch,
  parseLaunchUrl,
  getLastAttribution,
  startLinkingListener,
} from '../src/attribution/capture';
import { fingerprint, fingerprintHash } from '../src/attribution/fingerprint';
import { trackConversion } from '../src/attribution/track';
import * as storage from '../src/core/storage';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('attribution/capture', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    setConfig({
      onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600),
    });
    consent.__reset();
    __resetStorage();
    resetCapture();
    RN.__testHelpers.setPlatform('android');
    RN.__testHelpers.setInitialUrl(null);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    });
  });

  it('parses utm + click params from launch URL', () => {
    const out = parseLaunchUrl(
      'myapp://open?utm_source=whatsapp&utm_medium=broadcast&utm_campaign=spring&qa_click_id=qac_42'
    );
    expect(out).toMatchObject({
      source: 'whatsapp',
      medium: 'broadcast',
      campaign: 'spring',
      clickId: 'qac_42',
    });
    expect(out.launchUrl).toContain('myapp://open');
  });

  it('falls back to gclid then fbclid for clickId', () => {
    expect(parseLaunchUrl('https://x?gclid=abc').clickId).toBe('abc');
    expect(parseLaunchUrl('https://x?fbclid=def').clickId).toBe('def');
    expect(parseLaunchUrl('https://x').clickId).toBeUndefined();
  });

  it('captureLaunch reads Linking.getInitialURL and stores payload', async () => {
    RN.__testHelpers.setInitialUrl('myapp://?utm_source=email&utm_campaign=launch');
    const payload = await captureLaunch();
    expect(payload.source).toBe('email');
    expect(payload.campaign).toBe('launch');
    expect(payload.fingerprint.platform).toBe('android');
    expect(getLastAttribution()).toBe(payload);
  });

  it('capture() fires /v1/sdk/attribution/launch only when consent granted', async () => {
    await capture('myapp://?utm_source=fb');
    expect(global.fetch).not.toHaveBeenCalled();

    consent.set(true);
    await capture('myapp://?utm_source=fb');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/v1/sdk/attribution/launch');
  });

  it('startLinkingListener captures subsequent URLs', async () => {
    consent.set(true);
    startLinkingListener();
    RN.__testHelpers.setInitialUrl(null);
    RN.Linking.__emitUrl('myapp://?utm_source=push');
    // Allow the async capture() chain to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).toHaveBeenCalled();
    const last = getLastAttribution();
    expect(last?.source).toBe('push');
  });

  it('fingerprint() returns platform + screen dims', () => {
    const fp = fingerprint();
    expect(fp.platform).toBe('android');
    expect(fp.screenWidth).toBe(390);
    expect(fp.screenHeight).toBe(844);
  });

  it('fingerprintHash is stable for same input', () => {
    const fp = fingerprint();
    const a = fingerprintHash(fp);
    const b = fingerprintHash(fp);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('attribution — click matching + conversion wire format', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    setConfig({
      onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600),
    });
    consent.__reset();
    __resetStorage();
    resetCapture();
    RN.__testHelpers.setPlatform('android');
    RN.__testHelpers.setInitialUrl(null);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    });
  });

  it('recognises qa_clid — the parameter QuickAuth actually appends', () => {
    expect(parseLaunchUrl('myapp://open?qa_clid=qac_99').clickId).toBe('qac_99');
  });

  it('prefers qa_clid over every other click parameter', () => {
    const out = parseLaunchUrl(
      'myapp://open?gclid=g1&fbclid=f1&qa_click_id=old&qa_clid=qac_99'
    );
    expect(out.clickId).toBe('qac_99');
  });

  it('sends qa_clid as a top-level field on the launch body', async () => {
    consent.set(true);
    await capture('myapp://open?qa_clid=qac_99&utm_source=whatsapp');

    const [, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.qa_clid).toBe('qac_99');
    expect(body.source).toBe('whatsapp');
  });

  it('omits qa_clid when the launch URL carried no click id', async () => {
    consent.set(true);
    await capture('myapp://open?utm_source=whatsapp');

    const [, opts] = global.fetch.mock.calls[0];
    expect(JSON.parse(opts.body as string)).not.toHaveProperty('qa_clid');
  });

  it('keeps persisting the payload under the existing storage key', async () => {
    await capture('myapp://open?qa_clid=qac_99');
    const raw = await storage.getItem('qa.attribution');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).clickId).toBe('qac_99');
  });

  it('sends conversion custom fields as metadata, not attributes', async () => {
    consent.set(true);
    await capture('myapp://open?qa_clid=qac_99');
    global.fetch.mockClear();

    await trackConversion({ event: 'purchase', value: 499, attributes: { sku: 'x1' } });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/v1/sdk/attribution/conversion');
    const body = JSON.parse(opts.body as string);
    expect(body.metadata).toEqual({ sku: 'x1' });
    expect(body).not.toHaveProperty('attributes');
  });

  it('includes fingerprint.hash on the conversion attribution', async () => {
    consent.set(true);
    await capture('myapp://open?qa_clid=qac_99');
    global.fetch.mockClear();

    await trackConversion({ event: 'purchase' });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body as string);
    expect(body.attribution.fingerprint.hash).toBe(fingerprintHash(fingerprint()));
    expect(body.attribution.fingerprint.platform).toBe('android');
  });
});
