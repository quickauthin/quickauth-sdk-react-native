// Packaging guards. Assert on file contents for things jest can't exercise
// (Gradle builds, native code, request headers).

import * as fs from 'fs';
import * as path from 'path';
import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import { initiate, __resetSession } from '../src/auth/otp';
import { __resetStorage } from '../src/core/storage';
import { SDK_PLATFORM, SDK_VERSION } from '../src/version';
import { __resetAppIdentity } from '../src/core/app-identity';
import * as consent from '../src/core/consent';
import { setAuthEventHandler } from '../src/core/config';
import type { AuthEvent } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require('react-native');

declare const global: { fetch: jest.Mock };

const root = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
};

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('SDK version has one source', () => {
  it('src/version.ts is generated from package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_PLATFORM).toBe('react-native');
    expect(read('src/version.ts')).toContain('GENERATED FILE');
  });

  it('the request headers report that version, not a hand-maintained copy', async () => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    setConfig({ onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600) });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ state: 'OTP_SENT', sessionId: 's', expiresIn: 300 }),
    });

    await initiate({ phone: '+919876543210' });

    const headers = global.fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-QuickAuth-SDK']).toBe('react-native');
    expect(headers['X-QuickAuth-SDK-Version']).toBe(pkg.version);
  });

  it('no source file carries a second literal version string', () => {
    // Version must come from package.json, not be hardcoded in headers or Gradle.
    expect(read('src/core/client.ts')).not.toMatch(/['"]0\.1\.0['"]/);
    expect(read('android/build.gradle')).not.toMatch(/versionName\s+["']/);
  });

  it('the Android and iOS builds read package.json rather than restating it', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toContain('JsonSlurper');
    expect(gradle).toMatch(/versionName\s+quickauthSdkVersion/);
    expect(read('QuickAuthRnSdk.podspec')).toContain("package['version']");
  });
});

describe('Android manifest builds under AGP 8', () => {
  const manifest = read('android/src/main/AndroidManifest.xml');

  it('declares no package attribute', () => {
    // AGP 8 rejects package= in a library manifest.
    expect(manifest).not.toMatch(/<manifest[^>]*\spackage\s*=/);
  });

  it('declares the namespace in build.gradle instead', () => {
    expect(read('android/build.gradle')).toMatch(/namespace\s+'io\.quickauth\.rnsdk'/);
  });

  it('does not push the restricted RECEIVE_SMS permission into every host app', () => {
    // SMS Retriever needs no permission; RECEIVE_SMS is Play-restricted.
    expect(manifest).not.toMatch(/<uses-permission[^>]*RECEIVE_SMS/);
    expect(manifest).not.toMatch(/<uses-permission/);
  });
});

describe('WhatsApp zero-tap ships wired up', () => {
  const manifest = read('android/src/main/AndroidManifest.xml');
  const module = read('android/src/main/java/io/quickauth/rnsdk/QuickAuthSmsRetrieverModule.java');

  it('declares the receiver so a code can arrive with the app backgrounded', () => {
    expect(manifest).toContain('io.quickauth.rnsdk.WhatsAppOtpReceiver');
    expect(manifest).toContain('com.whatsapp.otp.OTP_RETRIEVED');
    expect(manifest).toMatch(/android:exported="true"/);
  });

  it('declares <queries>, without which Android 11+ drops the handshake', () => {
    expect(manifest).toMatch(/<package android:name="com\.whatsapp" \/>/);
    expect(manifest).toMatch(/<package android:name="com\.whatsapp\.w4b" \/>/);
  });

  it('sends the handshake to the same two packages the manifest can see', () => {
    expect(module).toContain('com.whatsapp.otp.OTP_REQUESTED');
    expect(module).toContain('"com.whatsapp", "com.whatsapp.w4b"');
    expect(module).toContain('FLAG_IMMUTABLE');
  });
});

describe('native OTP extraction and app hash', () => {
  const module = read('android/src/main/java/io/quickauth/rnsdk/QuickAuthSmsRetrieverModule.java');

  it('prefers a keyword-anchored code and otherwise takes the last run, not the first', () => {
    // e.g. "Your OTP for order 4471029 is 483920" must yield 483920.
    expect(module).toContain('KEYWORD_CODE');
    expect(module).toContain('APP_HASH_SUFFIX');
    // The last match wins in both passes.
    expect(module).toMatch(/while \(keyed\.find\(\)\) last = keyed\.group\(1\);/);
    expect(module).toMatch(/while \(runs\.find\(\)\) last = runs\.group\(1\);/);
  });

  it('reads signing certificates the modern way, and hashes toCharsString()', () => {
    expect(module).toContain('GET_SIGNING_CERTIFICATES');
    expect(module).toContain('getApkContentsSigners');
    expect(module).toContain('getSigningCertificateHistory');
    expect(module).toContain('toCharsString()');
    // Deprecated call kept only as the pre-API-28 fallback.
    const legacyUses = module.match(/PackageManager\.GET_SIGNATURES/g) ?? [];
    expect(legacyUses).toHaveLength(1);
  });
});

describe('AsyncStorage is a declared peer dependency', () => {
  it('is not marked optional any more', () => {
    expect(pkg.peerDependencies['@react-native-async-storage/async-storage']).toBeTruthy();
    expect(pkg.peerDependenciesMeta?.['@react-native-async-storage/async-storage']).toBeUndefined();
  });
});

describe('publishable key mode', () => {
  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
  });

  it('sends X-QuickAuth-Key and no Authorization header', async () => {
    setConfig({ publishableKey: 'pk_test_abc' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ state: 'OTP_SENT', sessionId: 's', expiresIn: 300 }),
    });

    await initiate({ phone: '+919876543210' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.quickauth.in/v1/sdk/auth/initiate');
    expect(init.headers['X-QuickAuth-Key']).toBe('pk_test_abc');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('does not try to mint a session token on a 401', async () => {
    setConfig({ publishableKey: 'pk_test_bad', maxRetries: 0 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ errorCode: 'INVALID_KEY' }),
    });

    await initiate({ phone: '+919876543210' }).catch(() => undefined);

    const urls = global.fetch.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u.endsWith('/v1/sdk/auth/initiate'))).toBe(true);
    expect(urls).toHaveLength(1);
  });
});

describe('parity with the Flutter SDK', () => {
  const okInitiate = () =>
    jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ state: 'OTP_SENT', sessionId: 's', expiresIn: 300 }),
    });

  beforeEach(() => {
    __resetConfig();
    __resetTokenManager();
    __resetSession();
    __resetStorage();
    __resetAppIdentity();
    consent.__reset();
    RN.__testHelpers.setPlatform('android');
  });

  it('publishable-key requests name the app (X-QuickAuth-Package on Android)', async () => {
    setConfig({ publishableKey: 'pk_test_abc' });
    global.fetch = okInitiate();
    await initiate({ phone: '+919876543210' });
    const headers = global.fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-QuickAuth-Package']).toBe('com.example.app');
    expect(headers['X-QuickAuth-Bundle']).toBeUndefined();
  });

  it('…and X-QuickAuth-Bundle on iOS', async () => {
    RN.__testHelpers.setPlatform('ios');
    setConfig({ publishableKey: 'pk_test_abc' });
    global.fetch = okInitiate();
    await initiate({ phone: '+919876543210' });
    const headers = global.fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-QuickAuth-Bundle']).toBe('com.example.app');
    RN.__testHelpers.setPlatform('android');
  });

  it('session-token requests do not send app identity headers', async () => {
    setConfig({ onTokenExpiry: async () => makeJwt(Math.floor(Date.now() / 1000) + 600) });
    global.fetch = okInitiate();
    await initiate({ phone: '+919876543210' });
    const headers = global.fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-QuickAuth-Package']).toBeUndefined();
  });

  it('sends deviceInfo with initiate only after consent', async () => {
    setConfig({ publishableKey: 'pk_test_abc' });
    global.fetch = okInitiate();
    await initiate({ phone: '+919876543210' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).deviceInfo).toBeUndefined();

    await consent.set(true);
    await initiate({ phone: '+919876543210' });
    const info = JSON.parse(global.fetch.mock.calls[1][1].body).deviceInfo;
    expect(info).toMatchObject({
      platform: 'android',
      appId: 'com.example.app',
      appVersion: '2.1.0',
      appBuild: '42',
      sdk: `react-native/${pkg.version}`,
    });
    expect(typeof info.timeZoneOffsetMinutes).toBe('number');
  });

  it('ERROR events carry the backend errorCode, status and message', async () => {
    setConfig({ publishableKey: 'pk_test_abc', maxRetries: 0 });
    const events: AuthEvent[] = [];
    setAuthEventHandler((e) => events.push(e));
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () =>
        JSON.stringify({ errorCode: 'OTP_ALREADY_PENDING', message: 'An OTP is already pending' }),
    });

    await expect(initiate({ phone: '+919876543210' })).rejects.toMatchObject({
      status: 409,
      errorCode: 'OTP_ALREADY_PENDING',
      message: '[QuickAuth] HTTP 409: An OTP is already pending',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([
      {
        type: 'ERROR',
        code: 'CLIENT_ERROR',
        message: '[QuickAuth] HTTP 409: An OTP is already pending',
        errorCode: 'OTP_ALREADY_PENDING',
        status: 409,
      },
    ]);
  });
});
