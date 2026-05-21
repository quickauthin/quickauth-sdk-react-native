import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import * as consent from '../src/core/consent';
import { trackConversion } from '../src/attribution/track';

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('core/consent gate', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    setConfig({
      onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600),
    });
    consent.__reset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    });
  });

  it('default state is unconsented', () => {
    expect(consent.get()).toBe(false);
  });

  it('set(true) toggles consent', () => {
    consent.set(true);
    expect(consent.get()).toBe(true);
    consent.set(false);
    expect(consent.get()).toBe(false);
  });

  it('drops trackConversion silently when consent is false', async () => {
    consent.set(false);
    await trackConversion({ event: 'signup', value: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends trackConversion when consent is true', async () => {
    consent.set(true);
    await trackConversion({ event: 'signup', value: 99, currency: 'INR' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/v1/sdk/attribution/conversion');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('signup');
    expect(body.value).toBe(99);
    expect(body.currency).toBe('INR');
  });

  it('rejects empty event names', async () => {
    consent.set(true);
    await expect(trackConversion({ event: '' })).rejects.toThrow();
  });
});
