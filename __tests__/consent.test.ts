import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import * as consent from '../src/core/consent';
import { trackConversion } from '../src/attribution/track';
import { __resetStorage, createMemoryStorage, setStorageAdapter } from '../src/core/storage';

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
    __resetStorage();
    setStorageAdapter(createMemoryStorage());
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

  it('queues trackConversion while consent is false, sends it on grant', async () => {
    consent.set(false);
    await trackConversion({ event: 'signup', value: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(consent.pendingCount()).toBe(1);

    await consent.set(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(consent.pendingCount()).toBe(0);
  });

  it('revoking drops queued work and stored attribution data', async () => {
    const store = createMemoryStorage();
    __resetStorage();
    setStorageAdapter(store);
    await consent.set(true);
    await store.setItem('qa.qa_clid', 'clid_1');
    await store.setItem('qa.device_token', 'keep-me');

    await consent.set(false);
    await trackConversion({ event: 'x' });
    await consent.set(false);

    expect(await store.getItem('qa.qa_clid')).toBeNull();
    expect(await store.getItem('qa.device_token')).toBe('keep-me'); // OneTap is not analytics
    expect(consent.pendingCount()).toBe(1);
  });

  it('the choice is saved and restored by hydrate()', async () => {
    await consent.set(true);
    consent.__reset();
    expect(consent.get()).toBe(false);
    await consent.hydrate(false);
    expect(consent.get()).toBe(true);
  });

  it('hydrate() uses the initial value when nothing was saved', async () => {
    await consent.hydrate(true);
    expect(consent.get()).toBe(true);
    await consent.hydrate(false);
    expect(consent.get()).toBe(false);
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
