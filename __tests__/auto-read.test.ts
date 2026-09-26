/**
 * Auto-read parity with the Flutter SDK: initiate() arms the code sources
 * itself, autoSubmit is off by default and latched when on, and resendOtp()
 * repeats the live attempt without being handed anything.
 *
 * Every test here covers something that was silently missing rather than
 * broken — the failures these guard against all look like "auto-fill just
 * doesn't happen for some users".
 */

import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import {
  initiate,
  observeOTP,
  publishAutoReadCode,
  resendOtp,
  reset,
  __resetSession,
} from '../src/auth/otp';
import { __resetSmsRetriever } from '../src/auth/sms-retriever';
import { __resetWhatsAppOtp } from '../src/auth/whatsapp-otp';
import { __resetNativeModule } from '../src/auth/native-module';
import { __resetStorage } from '../src/core/storage';
import { OtpChannel, type AuthEvent } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 's', exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A successful /initiate. */
function otpSent(sessionId = 's_1'): unknown {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ state: 'OTP_SENT', sessionId, expiresIn: 300 }),
  };
}

/** A successful /verify. */
function verified(requestId = 'req_1'): unknown {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({ state: 'VERIFIED', verified: true, requestId, message: 'ok' }),
  };
}

function bodyOf(callIndex: number): Record<string, unknown> {
  return JSON.parse((global.fetch as jest.Mock).mock.calls[callIndex][1].body);
}

function pathOf(callIndex: number): string {
  return String((global.fetch as jest.Mock).mock.calls[callIndex][0]);
}

const native = () => RN.NativeModules.QuickAuthSmsRetriever;

describe('auth/otp — auto-read, autoSubmit and resend', () => {
  let events: AuthEvent[];

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetSmsRetriever();
    __resetWhatsAppOtp();
    __resetNativeModule();
    __resetStorage();
    RN.__testHelpers.setPlatform('android');
    RN.__testHelpers.smsEmitter.removeAllListeners();
    jest.clearAllMocks();
    events = [];
    setConfig({
      onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600),
      onAuthEvent: (e) => events.push(e),
    });
    global.fetch = jest.fn();
  });

  // -- initiate arms auto-read itself --------------------------------------

  it('delivers an SMS code to a caller who never called observeOTP', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();

    expect(events).toContainEqual({ type: 'OTP_AUTO_READ', code: '483920' });
  });

  it('delivers a WhatsApp code to a caller who never called observeOTP', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210', channel: OtpChannel.WHATSAPP });
    await flush();

    RN.__testHelpers.emitWhatsAppCode({ code: '112233' });
    await flush();

    expect(events).toContainEqual({ type: 'OTP_AUTO_READ', code: '112233' });
  });

  it('subscribes to the WhatsApp receiver so a code held from before is flushed', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    expect(native().startWhatsAppOtpListener).toHaveBeenCalled();
  });

  // -- autoSubmit ----------------------------------------------------------

  it('does not submit an auto-read code by default', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1); // /initiate only
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ']);
  });

  it('submits an auto-read code when asked to, without any observeOTP subscriber', async () => {
    global.fetch.mockResolvedValueOnce(otpSent()).mockResolvedValueOnce(verified('req_auto'));
    await initiate({ phone: '+919876543210', autoSubmit: true });
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(pathOf(1)).toContain('/v1/sdk/auth/verify');
    expect(bodyOf(1)).toMatchObject({ sessionId: 's_1', code: '483920' });
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ', 'VERIFIED']);
  });

  it('submits once when the SMS and WhatsApp copies of one code both arrive', async () => {
    global.fetch.mockResolvedValueOnce(otpSent()).mockResolvedValueOnce(verified());
    await initiate({ phone: '+919876543210', autoSubmit: true });
    await flush();

    // Same code, both channels — a merchant on `auto` gets exactly this.
    RN.__testHelpers.emitSmsCode({ code: '483920' });
    RN.__testHelpers.emitWhatsAppCode({ code: '483920' });
    await flush();
    await flush();

    // Without the latch the second copy verifies a code the server has already
    // consumed, and the user sees a failure land right after a success.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'VERIFIED')).toHaveLength(1);
  });

  it('does not spend a second attempt when the duplicate arrives late', async () => {
    // The copies do not always race: the WhatsApp one can land seconds after
    // the SMS one has already been submitted and rejected, when the state
    // machine is back in awaiting_otp and would happily submit it again —
    // burning one of the user's three attempts on a code that just failed.
    global.fetch.mockResolvedValueOnce(otpSent()).mockResolvedValueOnce({
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
    });

    await initiate({ phone: '+919876543210', autoSubmit: true });
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();
    await flush();
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ', 'OTP_FAILED']);

    RN.__testHelpers.emitWhatsAppCode({ code: '483920' });
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('re-arms the latch on the next attempt', async () => {
    global.fetch
      .mockResolvedValueOnce(otpSent('s_1'))
      .mockResolvedValueOnce(verified('req_1'))
      .mockResolvedValueOnce(otpSent('s_2'))
      .mockResolvedValueOnce(verified('req_2'));

    await initiate({ phone: '+919876543210', autoSubmit: true });
    RN.__testHelpers.emitSmsCode({ code: '111111' });
    await flush();
    await flush();

    await resendOtp();
    RN.__testHelpers.emitSmsCode({ code: '222222' });
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(bodyOf(3)).toMatchObject({ sessionId: 's_2', code: '222222' });
  });

  it('publishAutoReadCode emits and honours the same latch', async () => {
    global.fetch.mockResolvedValueOnce(otpSent()).mockResolvedValueOnce(verified());
    await initiate({ phone: '+919876543210', autoSubmit: true });
    await flush();

    publishAutoReadCode('483920');
    await flush();
    await flush();
    // A second push, as an OTP field forwarding an autofill would do.
    publishAutoReadCode('483920');
    await flush();
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toHaveLength(1);
  });

  it('publishAutoReadCode ignores blank input', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    await flush();

    publishAutoReadCode('   ');
    await flush();

    expect(events.some((e) => e.type === 'OTP_AUTO_READ')).toBe(false);
  });

  // -- resendOtp -----------------------------------------------------------

  it('resendOtp replays the phone, channel and autoSubmit of the live attempt', async () => {
    global.fetch.mockResolvedValueOnce(otpSent('s_1')).mockResolvedValueOnce(otpSent('s_2'));

    await initiate({
      phone: '+919876543210',
      channel: OtpChannel.WHATSAPP,
      autoSubmit: true,
    });
    await resendOtp();

    expect(bodyOf(1)).toMatchObject({ phone: '+919876543210', channel: 'whatsapp' });

    // autoSubmit carried across: the resent code verifies itself.
    global.fetch.mockResolvedValueOnce(verified());
    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();
    await flush();
    expect(pathOf(2)).toContain('/v1/sdk/auth/verify');
  });

  it('resendOtp takes no arguments and rejects when there is nothing to resend', async () => {
    await expect(resendOtp()).rejects.toThrow(/nothing to resend/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('resendOtp rejects after reset() — a reset ends the attempt', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    await reset();
    await expect(resendOtp()).rejects.toThrow(/nothing to resend/);
  });

  it('resendOtp re-sends the WhatsApp handshake (Meta expires it after ten minutes)', async () => {
    global.fetch.mockResolvedValueOnce(otpSent('s_1')).mockResolvedValueOnce(otpSent('s_2'));
    await initiate({ phone: '+919876543210' });
    expect(native().sendWhatsAppOtpHandshake).toHaveBeenCalledTimes(1);
    await resendOtp();
    expect(native().sendWhatsAppOtpHandshake).toHaveBeenCalledTimes(2);
  });

  it('a resend does not stack auto-read subscriptions', async () => {
    global.fetch.mockResolvedValueOnce(otpSent('s_1')).mockResolvedValueOnce(otpSent('s_2'));
    await initiate({ phone: '+919876543210' });
    await resendOtp();
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();

    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toHaveLength(1);
  });

  it('opens a fresh SMS Retriever session for every request', async () => {
    // Google's session lasts five minutes and covers one message. A resend that
    // reused the first session would lose auto-read for a user who waited.
    global.fetch.mockResolvedValueOnce(otpSent('s_1')).mockResolvedValueOnce(otpSent('s_2'));
    await initiate({ phone: '+919876543210' });
    await resendOtp();
    await flush();

    expect(native().start).toHaveBeenCalledTimes(2);
  });

  // -- handshake ordering --------------------------------------------------

  it('clears the held code and sends the handshake BEFORE requesting the OTP', async () => {
    const order: string[] = [];
    native().clearWhatsAppOtp.mockImplementation(async () => {
      order.push('clear');
    });
    native().sendWhatsAppOtpHandshake.mockImplementation(async () => {
      order.push('handshake');
      return 'req-id';
    });
    global.fetch.mockImplementation(async () => {
      order.push('initiate');
      return otpSent();
    });

    await initiate({ phone: '+919876543210' });

    // WhatsApp checks for a live handshake when it receives the template, so
    // one sent after the request is too late for the message already in flight.
    expect(order).toEqual(['clear', 'handshake', 'initiate']);
  });

  // -- observeOTP ----------------------------------------------------------

  it('observeOTP merges both sources', async () => {
    const seen: string[] = [];
    const sub = observeOTP((code) => seen.push(code));

    RN.__testHelpers.emitSmsCode({ code: '111111' });
    RN.__testHelpers.emitWhatsAppCode({ code: '222222' });
    await flush();

    expect(seen).toEqual(['111111', '222222']);
    sub.remove();
  });

  it('announces one code once even with the SDK and the caller both subscribed', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    const seen: string[] = [];
    const sub = observeOTP((code) => seen.push(code));
    await flush();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();

    expect(seen).toEqual(['483920']);
    // Two live subscriptions, one event — a merchant driving their field from
    // OTP_AUTO_READ must not see it filled, cleared and filled again.
    expect(events.filter((e) => e.type === 'OTP_AUTO_READ')).toHaveLength(1);
    sub.remove();
  });

  it('reset() stops auto-read', async () => {
    global.fetch.mockResolvedValueOnce(otpSent());
    await initiate({ phone: '+919876543210' });
    await flush();
    await reset();

    RN.__testHelpers.emitSmsCode({ code: '483920' });
    await flush();

    expect(events.some((e) => e.type === 'OTP_AUTO_READ')).toBe(false);
  });

  // -- platform ------------------------------------------------------------

  it('is inert on iOS, where zero-tap does not exist', async () => {
    RN.__testHelpers.setPlatform('ios');
    __resetNativeModule();
    global.fetch.mockResolvedValueOnce(otpSent());

    await initiate({ phone: '+919876543210', autoSubmit: true });
    await flush();

    expect(native().startWhatsAppOtpListener).not.toHaveBeenCalled();
    expect(native().sendWhatsAppOtpHandshake).not.toHaveBeenCalled();

    // The one auto-read path iOS has is a field forwarding an OS autofill.
    global.fetch.mockResolvedValueOnce(verified());
    publishAutoReadCode('483920');
    await flush();
    await flush();
    expect(events.map((e) => e.type)).toEqual(['OTP_SENT', 'OTP_AUTO_READ', 'VERIFIED']);
  });
});
