import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import { startOTP, verifyOTP, observeOTP } from '../src/auth/otp';
import { OtpChannel } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

/** Build a JWT-shaped string with the given exp (seconds). Signature is junk. */
function makeJwt(expSeconds: number, sub = 'sess_test'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('auth/otp', () => {
  let tokenProvider: jest.Mock;

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    tokenProvider = jest.fn(async () => makeJwt(Math.floor(Date.now() / 1000) + 600));
    setConfig({ onTokenExpiry: tokenProvider });
    RN.__testHelpers.setPlatform('android');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('startOTP posts to /v1/sdk/auth/initiate with normalized phone + headers', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          session_id: 's_123',
          channel: 'sms',
          expires_at: '2030-01-01T00:00:00Z',
          sms_retriever_hash: 'ABC12345DEF',
        }),
    });

    const session = await startOTP({ phone: '+919876543210', channel: OtpChannel.AUTO });

    expect(session.sessionId).toBe('s_123');
    expect(session.smsRetrieverHash).toBe('ABC12345DEF');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.quickauth.in/v1/sdk/auth/initiate');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(opts.headers['X-QuickAuth-SDK']).toBe('react-native');
    expect(opts.headers['Idempotency-Key']).toMatch(/^qa_/);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(opts.body)).toMatchObject({
      phone: '+919876543210',
      channel: 'auto',
    });
  });

  it('rejects non-E.164 phone numbers', async () => {
    await expect(startOTP({ phone: '9876543210' })).rejects.toThrow(/E\.164/);
    await expect(startOTP({ phone: '+abc' })).rejects.toThrow(/E\.164/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed verify codes', async () => {
    await expect(verifyOTP({ sessionId: 's_1', code: 'abc' })).rejects.toThrow();
    await expect(verifyOTP({ sessionId: 's_1', code: '12' })).rejects.toThrow();
    await expect(verifyOTP({ sessionId: '', code: '123456' })).rejects.toThrow();
  });

  it('verifyOTP returns mapped result', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({ success: true, jwt: 'token123', user_id: 'u_1', phone: '+919876543210' }),
    });
    const result = await verifyOTP({ sessionId: 's_1', code: '123456' });
    expect(result).toEqual({
      success: true,
      jwt: 'token123',
      userId: 'u_1',
      phone: '+919876543210',
    });
    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
  });

  it('retries on 5xx and succeeds after retry', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => '{}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ session_id: 's_retry', channel: 'sms', expires_at: '2030-01-01T00:00:00Z' }),
      });
    const session = await startOTP({ phone: '+919876543210' });
    expect(session.sessionId).toBe('s_retry');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"bad_phone"}',
    });
    await expect(startOTP({ phone: '+919876543210' })).rejects.toThrow(/HTTP 400/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('observeOTP delivers SMS Retriever code on Android', () => {
    const cb = jest.fn();
    const sub = observeOTP(cb);
    RN.__testHelpers.smsEmitter.emit('qa.sms.code', { code: '123456' });
    expect(cb).toHaveBeenCalledWith('123456');
    sub.remove();
  });

  it('observeOTP is a no-op on iOS (returns inert subscription)', () => {
    RN.__testHelpers.setPlatform('ios');
    const cb = jest.fn();
    const sub = observeOTP(cb);
    RN.__testHelpers.smsEmitter.emit('qa.sms.code', { code: '999999' });
    expect(cb).not.toHaveBeenCalled();
    expect(typeof sub.remove).toBe('function');
    sub.remove();
  });
});
