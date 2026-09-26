/**
 * Packaging guards.
 *
 * These assert on files rather than behaviour, because the things they protect
 * cannot fail in a jest run — they fail in a merchant's Gradle build, or in a
 * backend log six weeks later. Each one has been wrong here at least once.
 */

import * as fs from 'fs';
import * as path from 'path';
import { __resetConfig, setConfig } from '../src/core/config';
import { __resetTokenManager } from '../src/core/client';
import { initiate, __resetSession } from '../src/auth/otp';
import { __resetStorage } from '../src/core/storage';
import { SDK_PLATFORM, SDK_VERSION } from '../src/version';

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
    // '0.1.0' was hardcoded in two request-header blocks and in the Gradle
    // versionName, so the SDK reported 0.1.0 to the backend for three releases.
    expect(read('src/core/client.ts')).not.toMatch(/['"]0\.1\.0['"]/);
    expect(read('android/build.gradle')).not.toMatch(/versionName\s+["']/);
  });

  it('the Android and iOS builds read package.json rather than restating it', () => {
    const gradle = read('android/build.gradle');
    expect(gradle).toContain('JsonSlurper');
    expect(gradle).toMatch(/versionName\s+quickauthSdkVersion/);
    expect(read('ios/QuickAuthRnSdk.podspec')).toContain("package['version']");
  });
});

describe('Android manifest builds under AGP 8', () => {
  const manifest = read('android/src/main/AndroidManifest.xml');

  it('declares no package attribute', () => {
    // AGP 8 fails the consuming app's build outright on this: "Setting the
    // namespace via the package attribute ... is no longer supported". Every
    // current React Native template is on AGP 8, so this one attribute made the
    // SDK impossible to build against.
    expect(manifest).not.toMatch(/<manifest[^>]*\spackage\s*=/);
  });

  it('declares the namespace in build.gradle instead', () => {
    expect(read('android/build.gradle')).toMatch(/namespace\s+'io\.quickauth\.rnsdk'/);
  });

  it('does not push the restricted RECEIVE_SMS permission into every host app', () => {
    // SMS Retriever needs no permission, and RECEIVE_SMS is in Play's
    // restricted set — a library manifest declaring it creates a review
    // problem for every merchant in exchange for nothing.
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
    // "Your OTP for order 4471029 is 483920" used to auto-fill the order number.
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
    // The deprecated call survives only as the pre-API-28 fallback, where it is
    // the only option and key rotation does not exist.
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
