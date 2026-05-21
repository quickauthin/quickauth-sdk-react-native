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
