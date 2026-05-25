import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import {
  initiate,
  submitOtp,
  reset,
  observeOTP,
  __resetSession,
} from '../src/auth/otp';
import { __resetStorage } from '../src/core/storage';
import { OtpChannel, type AuthEvent } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

/** Build a JWT-shaped string with the given exp (seconds). Signature is junk. */
function makeJwt(expSeconds: number, sub = 'sess_test'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('auth/otp — headless flow', () => {
  let tokenProvider: jest.Mock;
  let events: AuthEvent[];

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    events = [];
    tokenProvider = jest.fn(async () => makeJwt(Math.floor(Date.now() / 1000) + 600));
    setConfig({
      onTokenExpiry: tokenProvider,
      onAuthEvent: (e) => events.push(e),
    });
    RN.__testHelpers.setPlatform('android');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('initiate posts to /v1/sdk/auth/initiate with phone + channel and emits OTP_SENT', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          state: 'OTP_SENT',
          sessionId: 's_123',
          expiresIn: 300,
          deviceToken: 'dtok_new',
        }),
    });

    await initiate({ phone: '+919876543210', channel: OtpChannel.AUTO });
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.quickauth.in/v1/sdk/auth/initiate');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(JSON.parse(opts.body)).toMatchObject({
      phone: '+919876543210',
      channel: 'auto',
    });

    expect(events).toEqual([
      { type: 'OTP_SENT', sessionId: 's_123', channel: OtpChannel.AUTO, expiresIn: 300 },
    ]);
  });

  it('initiate emits VERIFIED directly when backend reports OneTap', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          state: 'VERIFIED',
          sessionId: 'req_verified',
          expiresIn: 300,
          deviceToken: 'dtok_x',
        }),
    });

    await initiate({ phone: '+919876543210' });
    await flush();

    expect(events).toEqual([
      { type: 'VERIFIED', requestId: 'req_verified' },
    ]);
  });

  it('replays stored device token on subsequent initiate calls', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'OTP_SENT',
            sessionId: 's_1',
            expiresIn: 300,
            deviceToken: 'dtok_abc',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'VERIFIED',
            sessionId: 'req_v',
            expiresIn: 300,
            deviceToken: 'dtok_abc',
          }),
      });

    await initiate({ phone: '+919876543210' });
    await initiate({ phone: '+919876543210' });

    const secondBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(secondBody).toMatchObject({
      phone: '+919876543210',
      deviceToken: 'dtok_abc',
    });
  });

  it('rejects non-E.164 phone numbers', async () => {
    await expect(initiate({ phone: '9876543210' })).rejects.toThrow(/E\.164/);
    await expect(initiate({ phone: '+abc' })).rejects.toThrow(/E\.164/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('submitOtp before initiate throws', async () => {
    await expect(submitOtp('123456')).rejects.toThrow(/must follow an OTP_SENT/);
  });

  it('submitOtp emits VERIFIED on success and forwards device token', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'OTP_SENT',
            sessionId: 's_1',
            expiresIn: 300,
            deviceToken: 'dtok_v',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'VERIFIED',
            verified: true,
            requestId: 'req_abc',
            message: 'Verified successfully',
          }),
      });

    await initiate({ phone: '+919876543210' });
    await submitOtp('123456');
    await flush();

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'VERIFIED']);
    const verifyBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(verifyBody).toMatchObject({
      sessionId: 's_1',
      code: '123456',
      deviceToken: 'dtok_v',
    });
  });

  it('submitOtp emits OTP_FAILED on wrong code and remains retry-able', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'OTP_SENT',
            sessionId: 's_1',
            expiresIn: 300,
            deviceToken: 'dtok_v',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'OTP_FAILED',
            verified: false,
            requestId: 's_1',
            message: 'Invalid OTP. 2 attempt(s) remaining.',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            state: 'VERIFIED',
            verified: true,
            requestId: 'req_abc',
            message: 'Verified successfully',
          }),
      });

    await initiate({ phone: '+919876543210' });
    await submitOtp('000000');
    await submitOtp('123456');
    await flush();

    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_FAILED', 'VERIFIED']);
  });

  it('submitOtp rejects malformed code', async () => {
    await expect(submitOtp('abc')).rejects.toThrow(/digits/);
    await expect(submitOtp('12')).rejects.toThrow(/digits/);
  });

  it('reset with forgetDevice clears stored token', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          state: 'OTP_SENT',
          sessionId: 's_1',
          expiresIn: 300,
          deviceToken: 'dtok_1',
        }),
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          state: 'OTP_SENT',
          sessionId: 's_2',
          expiresIn: 300,
          deviceToken: 'dtok_2',
        }),
    });

    await initiate({ phone: '+919876543210' });
    await reset({ forgetDevice: true });
    await initiate({ phone: '+919876543210' });

    const secondBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(secondBody.deviceToken).toBeUndefined();
  });

  it('emits ERROR on transport failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => '{}',
    });

    await expect(initiate({ phone: '+919876543210' })).rejects.toBeDefined();
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ERROR');
  });

  it('observeOTP delivers SMS Retriever code on Android and emits OTP_AUTO_READ', async () => {
    const cb = jest.fn();
    const sub = observeOTP(cb);
    RN.__testHelpers.smsEmitter.emit('qa.sms.code', { code: '123456' });
    await flush();
    expect(cb).toHaveBeenCalledWith('123456');
    expect(events).toEqual([{ type: 'OTP_AUTO_READ', code: '123456' }]);
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
