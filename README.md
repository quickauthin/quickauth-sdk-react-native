# @quick-auth/react-native-sdk

Phone OTP authentication + WhatsApp marketing attribution for React Native.

- Send + verify OTP over **SMS** or **WhatsApp**
- Android SMS auto-read via Google Play **SMS Retriever** (no SMS permission)
- Android **WhatsApp zero-tap / one-tap** auto-read, with no extra setup in your app
- Optional **auto-submit**: the SDK verifies a code it read, guarded so one code is never verified twice
- iOS OTP autofill via native `textContentType="oneTimeCode"`
- WhatsApp deep-link login via `Linking`
- Campaign attribution from the launch link's `qa_clid` (same format as the Flutter and Web SDKs)
- Lightweight device fingerprint (no `react-native-device-info` dependency)
- Conversion tracking gated by user consent (DPDP / GDPR); calls are queued until consent is granted
- **Two usage modes**: headless API and drop-in components

## Install

```bash
npm install @quick-auth/react-native-sdk
# iOS only
cd ios && pod install
```

Requires React Native 0.72 or newer. The native module is auto-linked.

### Storage (required)

```bash
npm install @react-native-async-storage/async-storage
```

This is a required **peer dependency**. The SDK stores the OneTap device token (silent re-authentication for returning users) and it has to persist across app restarts.

If no storage is available, `init()` throws. To use something other than AsyncStorage, pass your own adapter:

```ts
import QuickAuth, { createMemoryStorage } from '@quick-auth/react-native-sdk';

// MMKV, Keychain, EncryptedStorage: anything with async getItem/setItem/removeItem
await QuickAuth.init({ onTokenExpiry, storage: myAdapter });

// Or keep it in memory only (OneTap will not survive a restart):
await QuickAuth.init({ onTokenExpiry, storage: createMemoryStorage() });
```

## Auth modes

Pass exactly one of these to `init()`. Passing none, or more than one, throws.

| Mode | Credential in the app | Backend needed | Use for |
| --- | --- | --- | --- |
| `publishableKey` | `pk_live_…` (safe to ship) | only to confirm logins | most apps |
| `onTokenExpiry` | short-lived session JWT | yes, mints tokens | apps that want per-user gating of OTP sends |
| `unsafe` | `client_secret` (**never ship**) | no | trusted internal builds only |

Your `client_secret` must never be in a public app binary, whichever mode you use.

### Publishable key (recommended)

```ts
await QuickAuth.init({
  publishableKey: 'pk_live_…', // dashboard → your app → Keys
  onAuthEvent: (event) => { /* … */ },
});
```

A publishable key is designed to ship inside the app: it only allows OTP send/verify, is locked to your registered app, and is rate-limited. The SDK sends it as an `X-QuickAuth-Key` header; no token minting is involved.

### Session tokens (`onTokenExpiry`)

Your **own backend** mints a short-lived (10-minute) session JWT, and the SDK uses it as a `Bearer` token. When the token is about to expire, the SDK calls your `onTokenExpiry` async callback to get a new one. Same pattern as Twilio Verify, Stripe, etc.

```ts
import QuickAuth from '@quick-auth/react-native-sdk';

await QuickAuth.init({
  onTokenExpiry: async () => {
    const res = await fetch('https://my-app.com/api/quickauth-token', {
      headers: { Authorization: `Bearer ${myUserToken}` },
    });
    return (await res.json()).sessionToken;
  },
});
```

### Customer's backend (Express, ~5 lines)

```js
app.post('/api/quickauth-token', authenticateUser, async (req, res) => {
  const r = await fetch('https://api.quickauth.in/v1/sdk/session', {
    method: 'POST',
    headers: {
      'X-Client-Id': process.env.QUICKAUTH_CLIENT_ID,
      'X-Client-Secret': process.env.QUICKAUTH_CLIENT_SECRET,
    },
  });
  res.json(await r.json()); // { sessionToken: "eyJ…", expiresAt: "…" }
});
```

The SDK refreshes the token automatically ~30s before expiry, deduplicates concurrent refreshes (single-flight), and on a `401` it invalidates the cached token and retries the request once with a fresh one.

### Trusted-enterprise escape hatch (`unsafe`)

For server-rendered apps or trusted internal builds where embedding `client_secret` is acceptable, the SDK can mint sessions itself:

```ts
await QuickAuth.init({
  unsafe: {
    clientId: process.env.QUICKAUTH_CLIENT_ID!,
    clientSecret: process.env.QUICKAUTH_CLIENT_SECRET!,
  },
});
```

The SDK logs a `console.warn` on init reminding you this is unsafe for public mobile binaries.

## Confirm the login on your backend

`VERIFIED` on the device is not proof for your server: anyone can call your API with a made-up result. Send the event's `requestId` to your backend and confirm it server-to-server before you create a session:

```js
app.post('/api/login', async (req, res) => {
  const { requestId, phone } = req.body;
  const r = await fetch(
    `https://api.quickauth.in/v1/auth/status?requestId=${encodeURIComponent(requestId)}`,
    {
      headers: {
        'X-Client-Id': process.env.QUICKAUTH_CLIENT_ID,
        'X-Client-Secret': process.env.QUICKAUTH_CLIENT_SECRET,
      },
    }
  );
  const status = await r.json();
  // { requestId, identity: "+9198…", identityType: "MOBILE", authStatus: "VERIFIED",
  //   verifiedAt: "2026-…Z", mode: "OTP", deliveries: [{ channel: "SMS", deliveryStatus: "DELIVERED" }] }
  if (!r.ok || status.authStatus !== 'VERIFIED' || status.identity !== phone) {
    return res.status(401).json({ ok: false });
  }
  // Accept each requestId only once. QuickAuth keeps answering VERIFIED for it,
  // so store used ids and reject repeats.
  // …create your own user session here…
  res.json({ ok: true });
});
```

An unknown `requestId` returns `400` with `errorCode: "TRANSACTION_NOT_FOUND"`; wrong client credentials return `401` with `INVALID_CLIENT_CREDENTIALS`.

## Quick start: headless

Every outcome arrives on one typed event handler. The async methods resolve when the network call is done; the events are the source of truth for what to render.

```ts
import QuickAuth, { OtpChannel } from '@quick-auth/react-native-sdk';

await QuickAuth.init({
  onTokenExpiry: async () => {
    const r = await fetch('https://my-app.com/api/quickauth-token');
    return (await r.json()).sessionToken;
  },
  onAuthEvent: (event) => {
    switch (event.type) {
      case 'OTP_SENT':      return showOtpInput(event.sessionId, event.expiresIn);
      case 'OTP_AUTO_READ': return prefill(event.code);
      case 'VERIFIED':      return finishLogin(event.requestId);
      case 'OTP_FAILED':    return showError(event.message);
      case 'ERROR':         return showError(event.message);
    }
  },
});
QuickAuth.consent.set(true); // call this AFTER your in-app consent dialog

// 1. Attribute the launch. Resolves with the backend's answer:
//    { matched, qaClid?, campaignId?, templateId?, variantId? }
const attribution = await QuickAuth.attribution.captureLaunch();

// 2. Send the OTP. This also starts auto-read; you don't need to subscribe to
//    anything for OTP_AUTO_READ to arrive.
await QuickAuth.auth.initiate({
  phone: '+919876543210',
  channel: OtpChannel.AUTO,   // auto | sms | whatsapp
  autoSubmit: true,           // optional; off by default
});

// 3. Submit what the user typed (skip this entirely when autoSubmit is on)
await QuickAuth.auth.submitOtp('123456');

// 4. Resend: no arguments, it repeats the current attempt
await QuickAuth.auth.resendOtp();

// 5. Forward `requestId` from the VERIFIED event to YOUR backend, which
//    confirms with QuickAuth via GET /v1/auth/status?requestId=… and mints its
//    own session. QuickAuth is verification-only; your backend owns the session.

// 6. Track conversion
await QuickAuth.attribution.trackConversion({ event: 'signup', value: 0, metadata: { plan: 'free' } });

// Sign-out: drop the device token so the next initiate() is a fresh install.
await QuickAuth.auth.reset({ forgetDevice: true });
```

### Auto-read, and what `autoSubmit` guards against

`initiate()` listens to both Android's SMS Retriever and WhatsApp zero-tap / one-tap, and raises `OTP_AUTO_READ` for whichever delivers the code. `observeOTP()` gives you the raw codes too, but you don't need it for auto-read.

`autoSubmit` is off by default; when on, the SDK verifies the code it read. It submits at most once per attempt, because on the `auto` channel the same code can arrive twice (once from SMS, once from WhatsApp) and a second submit would fail against an already-used code. This resets on the next `initiate()` or `resendOtp()`.

If you source codes yourself (a notification listener, a paste handler), feed them in and they behave identically:

```ts
QuickAuth.auth.publishAutoReadCode('483920');
```

### `resendOtp()` takes no arguments

It resends to the phone number of the current attempt, with the same channel and `autoSubmit` setting, and re-sends the WhatsApp handshake (Meta expires it after ten minutes).

It rejects when there is no attempt to resend, including after `reset()`. Only show a resend button after a code has been sent.

## Quick start: components

```tsx
import {
  QuickAuthLoginButton,
  QuickAuthOtpField,
} from '@quick-auth/react-native-sdk';

<QuickAuthLoginButton
  phone="+919876543210"
  text="Continue"
  onInitiated={() => setError(null)}   // outcomes arrive on onAuthEvent
  onError={(err) => setError(err.message)}
/>

<QuickAuthOtpField
  value={code}
  onChangeText={setCode}
  digitCount={6}
  autoFillFromSms                 // Android SMS Retriever + WhatsApp
  onCodeFilled={(code) => QuickAuth.auth.submitOtp(code)}
/>
```

`<QuickAuthOtpField/>` renders a 6-cell OTP field whose hidden `TextInput` sets `textContentType="oneTimeCode"` (iOS) and `autoComplete="sms-otp"` (Android), so OS-level autofill works alongside the explicit auto-read path.

On iOS, OS autofill is the only auto-read available, so the field passes an autofilled code back to the SDK. This makes `OTP_AUTO_READ` and `autoSubmit` work the same on both platforms. Codes typed by hand are not forwarded. Pass `forwardsAutofillToQuickAuth={false}` to opt out.

## Public API

```ts
QuickAuth.init({
  // exactly one of:
  publishableKey,   // 'pk_live_…' (recommended)
  onTokenExpiry,    // async () => Promise<string>, your backend mints session tokens
  unsafe,           // { clientId, clientSecret }, trusted internal builds only
  // optional:
  onAuthEvent?,     // (event: AuthEvent) => void, all auth events
  storage?,         // { getItem, setItem, removeItem }, defaults to AsyncStorage
  initialToken?,    // pre-warmed session token for the first request (with onTokenExpiry)
  consent?,         // initial attribution consent; a saved consent.set() choice wins
  apiBaseUrl?,
  maxRetries?,
  requestTimeoutMs?,
  silent?,
})
QuickAuth.isInitialized: boolean
QuickAuth.config: ResolvedConfig
QuickAuth.tokenManager: TokenManager
QuickAuth.setAuthEventHandler(handler | null)   // attach from a screen, not at startup
QuickAuth.reset(): Promise<void>                // tear down; keeps the device token

QuickAuth.consent.set(granted: boolean): Promise<boolean>  // saved; granting replays queued calls
QuickAuth.consent.get(): boolean
QuickAuth.consent.pendingCount(): number

QuickAuth.auth.initiate({ phone, channel?, autoSubmit? }): Promise<void>
QuickAuth.auth.submitOtp(code: string): Promise<void>
QuickAuth.auth.resendOtp(): Promise<void>
QuickAuth.auth.reset({ forgetDevice? }): Promise<void>
QuickAuth.auth.publishAutoReadCode(code: string): void
QuickAuth.auth.observeOTP((code) => void): OtpSubscription
QuickAuth.auth.startWhatsAppLogin({ businessNumber, message? }): Promise<void>
QuickAuth.auth.getSmsRetrieverHash(): Promise<string | null>
QuickAuth.auth.getSmsRetrieverHashes(): Promise<string[]>

QuickAuth.whatsapp.open({ businessNumber, message? }): Promise<boolean>
QuickAuth.whatsapp.sendOtpHandshake(): Promise<string | null>
QuickAuth.whatsapp.clearPendingOtp(): Promise<void>
QuickAuth.whatsapp.observeOtp((code) => void): OtpSubscription

QuickAuth.attribution.captureLaunch(): Promise<AttributionResult>
QuickAuth.attribution.capture(url: string | null): Promise<AttributionResult>
QuickAuth.attribution.trackConversion({ event, value?, currency?, metadata? })
QuickAuth.attribution.qaClid(): Promise<string | null>
QuickAuth.attribution.getLastAttribution(): AttributionResult | null
QuickAuth.attribution.getFingerprint(): DeviceFingerprint
QuickAuth.attribution.getFingerprintHash(): string
```

`AuthEvent` is a discriminated union on `type`:

| `type`          | payload                             |
| --------------- | ----------------------------------- |
| `OTP_SENT`      | `sessionId`, `channel`, `expiresIn` |
| `OTP_AUTO_READ` | `code`                              |
| `VERIFIED`      | `requestId`, `message?`             |
| `OTP_FAILED`    | `message`                           |
| `ERROR`         | `code`, `message`, `errorCode?`, `status?` |

## Android app-hash

Both auto-read paths are matched on the same 11-character hash, derived from your package name and signing certificate. An OTP SMS must end with it, and a WhatsApp authentication template must list your package name and hash under `supported_apps`.

```ts
const hash = await QuickAuth.auth.getSmsRetrieverHash();

// Apps with a rotated signing key have several hashes; register all of them.
const all = await QuickAuth.auth.getSmsRetrieverHashes();
```

Use the hash for the build you actually ship: a debug build signed with the debug keystore has a different hash from a Play-signed release, and Play App Signing re-signs your upload with Google's key, so take the release hash from an internal-testing install rather than from a local build.

The dashboard's SMS template editor lets you paste this hash so customer-facing OTP messages always include it for production builds.

## WhatsApp zero-tap / one-tap

Nothing to configure in your app. The SDK's Android manifest contributes the receiver Meta requires plus `<queries>` for `com.whatsapp` and `com.whatsapp.w4b`, and `initiate()`/`resendOtp()` broadcast the `OTP_REQUESTED` handshake before each request. Codes arrive as `OTP_AUTO_READ` exactly like SMS ones.

What is on your side is the template: it must be an approved **authentication** template with zero-tap enabled, listing your package name and app-hash under `supported_apps`. If any of these is missing, the message still arrives but the code is not auto-filled, and no error is raised. `adb logcat -s QuickAuthWaOtp` reports whether the handshake reached a visible WhatsApp install.

## Backend endpoints used

| Method | Path                              | Purpose                                            |
| ------ | --------------------------------- | -------------------------------------------------- |
| POST   | `/v1/sdk/session`                 | Mint 10-min session JWT (server-to-server only)    |
| POST   | `/v1/sdk/auth/initiate`           | Start an OTP session                               |
| POST   | `/v1/sdk/auth/verify`             | Verify a code; returns `requestId`                 |
| POST   | `/v1/sdk/attribution/launch`      | `{ qa_clid?, fingerprint, deviceInfo }` → match result |
| POST   | `/v1/sdk/attribution/conversion`  | `{ event, value, currency, qa_clid?, metadata? }`  |
| GET    | `/v1/auth/status?requestId=…`     | Confirm a login (your backend, server-to-server)   |

Every SDK request sends either `X-QuickAuth-Key: <publishableKey>` (with `X-QuickAuth-Package` on Android or `X-QuickAuth-Bundle` on iOS, naming your app) or `Authorization: Bearer <sessionToken>`, plus an `Idempotency-Key` header. 5xx responses (and 408 / 429) retry up to `maxRetries` times (default 2) with exponential backoff (1s, 2s, capped at 4s); 4xx responses fail fast. In session-token mode a `401` triggers a single token-refresh + retry.

## Privacy (DPDP / GDPR)

- Consent is off by default. Attribution and conversion calls made before consent are **queued** and sent once `consent.set(true)` is called; the choice is saved, so it survives restarts. Revoking drops the queue and the attribution data stored on the device (the OneTap device token is kept, since it is not analytics).
- OTP send/verify always run regardless of consent (they are service actions, not analytics). Once consent is granted they also carry a `deviceInfo` block (platform, OS version, locale, UTC offset, app id/version) for the backend's audit log.
- Device fingerprint is coarse (a random per-install id, locale, UTC offset, screen size). No IDFA, no IDFV, no MAC, no IMEI.
- The `qa_clid` and the device token are stored locally through the configured storage adapter. `QuickAuth.auth.reset({ forgetDevice: true })` drops the device token, which is what a sign-out should do.

## Build / test

```bash
npm ci
npm run build      # builder-bob: lib/commonjs + lib/module + lib/typescript
npm test           # jest unit tests
```

The SDK version has exactly one home: `package.json`. `src/version.ts` is generated from it by `scripts/sync-version.js` (run automatically before `npm run build`, verified before `npm test`), `android/build.gradle` reads it with `JsonSlurper`, and the podspec parses it. Do not edit `src/version.ts`; run `npm version` instead.

## License

MIT © QuickAuth
