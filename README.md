# @quickauth/react-native

Phone OTP authentication + WhatsApp marketing attribution for React Native.

- Send + verify OTP over **SMS** or **WhatsApp**
- Android SMS auto-read via Google Play **SMS Retriever** (no SMS permission)
- Android **WhatsApp zero-tap / one-tap** auto-read — receiver, handshake and `<queries>` ship in the SDK; merchants declare nothing
- Optional **auto-submit**: the SDK verifies a code it read, guarded so one code is never verified twice
- iOS OTP autofill via native `textContentType="oneTimeCode"` — zero config
- WhatsApp deep-link login via `Linking`
- Attribution capture from launch URL (`utm_*`, `qa_click_id`, `gclid`, `fbclid`, …)
- Lightweight device fingerprint (no `react-native-device-info` dependency)
- Conversion tracking gated by user consent (DPDP / GDPR)
- **Two usage modes**: headless API and drop-in components

## Install

```bash
npm install @quickauth/react-native
# iOS only
cd ios && pod install
```

The native module is auto-linked via React Native CLI ≥ 0.60.

### Storage (required)

```bash
npm install @react-native-async-storage/async-storage
```

This is a **peer dependency**, not an optional one. The SDK stores the device token that powers OneTap — silent re-authentication for a returning user — and that only works if the token outlives the process.

Earlier versions fell back to an in-memory `Map` when AsyncStorage was missing. Everything looked fine for the length of a session, and OneTap silently never fired again after a cold start. `init()` now throws instead, naming the fix. If you would rather not add AsyncStorage, pass your own adapter:

```ts
import QuickAuth, { createMemoryStorage } from '@quickauth/react-native';

// MMKV, Keychain, EncryptedStorage — anything with async getItem/setItem/removeItem
await QuickAuth.init({ onTokenExpiry, storage: myAdapter });

// …or accept that OneTap will not survive a restart, deliberately:
await QuickAuth.init({ onTokenExpiry, storage: createMemoryStorage() });
```

## Auth model — ephemeral session tokens

QuickAuth never wants your `client_secret` shipped in a mobile binary. Instead, your **own backend** mints a short-lived (10-minute) session JWT, and the SDK uses it as a `Bearer` token. When the token is about to expire, the SDK calls your `onTokenExpiry` async callback to get a new one. Same pattern as Twilio Verify, Stripe, etc.

```ts
import QuickAuth, { OtpChannel } from '@quickauth/react-native';

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

## Quick start — headless

Every outcome arrives on one typed event handler. The async methods resolve when the network call is done; the events are the source of truth for what to render.

```ts
import QuickAuth, { OtpChannel } from '@quickauth/react-native';

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

// 1. Capture launch attribution (deep-link UTM / click IDs)
await QuickAuth.attribution.captureLaunch();

// 2. Send the OTP. This also arms auto-read — you do not have to subscribe to
//    anything for OTP_AUTO_READ to arrive.
await QuickAuth.auth.initiate({
  phone: '+919876543210',
  channel: OtpChannel.AUTO,   // auto | sms | whatsapp
  autoSubmit: true,           // optional; off by default
});

// 3. Submit what the user typed (skip this entirely when autoSubmit is on)
await QuickAuth.auth.submitOtp('123456');

// 4. "Didn't get it?" — no arguments; it repeats the live attempt
await QuickAuth.auth.resendOtp();

// 5. Forward `requestId` from the VERIFIED event to YOUR backend, which
//    confirms with QuickAuth via GET /v1/auth/status?requestId=… and mints its
//    own session. QuickAuth is verification-only; your backend owns the session.

// 6. Track conversion
await QuickAuth.attribution.trackConversion({ event: 'signup', currency: 'INR' });

// Sign-out: drop the device token so the next initiate() is a fresh install.
await QuickAuth.auth.reset({ forgetDevice: true });
```

### Auto-read, and what `autoSubmit` guards against

`initiate()` subscribes to both code sources itself — Android's SMS Retriever and WhatsApp's zero-tap / one-tap broadcast — and raises `OTP_AUTO_READ` for whichever delivers. `observeOTP()` is available if you want the raw codes as well, but it is not required for auto-read to work.

`autoSubmit` is off by default; when on, the SDK verifies the code it read. It is guarded by a one-shot latch per attempt, because a merchant on `auto` can receive the *same* code twice — once parsed out of the SMS, once broadcast by WhatsApp. Submitting the second would verify a code the server has already consumed, and the user would watch a failure land right after a success. The latch resets on the next `initiate()` or `resendOtp()`.

If you source codes yourself (a notification listener, a paste handler), feed them in and they behave identically:

```ts
QuickAuth.auth.publishAutoReadCode('483920');
```

### `resendOtp()` takes no arguments

It replays the phone number the current attempt is already for, carrying that attempt's channel and `autoSubmit` setting, and re-sends the WhatsApp handshake (Meta expires it after ten minutes). Asking for the number again is an opportunity to pass a different one by accident, which starts a second transaction and leaves the user holding two codes, only one of which works.

It rejects when there is no attempt to resend, including after `reset()` — a resend button should only exist once a code has been sent.

## Quick start — components

```tsx
import {
  QuickAuthLoginButton,
  QuickAuthOtpField,
} from '@quickauth/react-native';

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

On iOS that OS autofill is the *only* auto-read there is — the code goes straight into the field and the SDK is never told. The field therefore forwards an all-at-once fill back into the SDK, so `OTP_AUTO_READ` and `autoSubmit` behave the same on both platforms. A user typing the last digit of a code they read themselves is not forwarded. Pass `forwardsAutofillToQuickAuth={false}` to opt out.

## Public API

```ts
QuickAuth.init({
  onTokenExpiry,    // async () => Promise<string> — REQUIRED for production
  onAuthEvent?,     // (event: AuthEvent) => void — the whole auth lifecycle
  storage?,         // { getItem, setItem, removeItem } — defaults to AsyncStorage
  initialToken?,    // optional pre-warmed token for the very first request
  unsafe?,          // { clientId, clientSecret } — trusted-enterprise only
  apiBaseUrl?,
  maxRetries?,
  requestTimeoutMs?,
  silent?,
})
QuickAuth.isInitialized(): boolean
QuickAuth.config(): ResolvedConfig
QuickAuth.tokenManager(): TokenManager
QuickAuth.setAuthEventHandler(handler | null)   // attach from a screen, not at startup
QuickAuth.reset(): Promise<void>                // tear down; keeps the device token

QuickAuth.consent.set(granted: boolean)
QuickAuth.consent.get(): boolean

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

QuickAuth.attribution.captureLaunch(): Promise<AttributionPayload>
QuickAuth.attribution.capture(url: string | null): Promise<AttributionPayload>
QuickAuth.attribution.trackConversion({ event, value?, currency?, attributes? })
QuickAuth.attribution.getFingerprint(): DeviceFingerprint
QuickAuth.attribution.getFingerprintHash(): string
QuickAuth.attribution.getLastAttribution(): AttributionPayload | null
```

`AuthEvent` is a discriminated union on `type`:

| `type`          | payload                             |
| --------------- | ----------------------------------- |
| `OTP_SENT`      | `sessionId`, `channel`, `expiresIn` |
| `OTP_AUTO_READ` | `code`                              |
| `VERIFIED`      | `requestId`, `message?`             |
| `OTP_FAILED`    | `message`                           |
| `ERROR`         | `code`, `message`                   |

## Android app-hash

Both auto-read paths are matched on the same 11-character hash, derived from your package name and signing certificate. An OTP SMS must end with it, and a WhatsApp authentication template must list your package name and hash under `supported_apps`.

```ts
const hash = await QuickAuth.auth.getSmsRetrieverHash();

// Apps that have rotated their signing key have more than one, and every one
// of them must be registered — devices holding the other certificate get
// nothing otherwise.
const all = await QuickAuth.auth.getSmsRetrieverHashes();
```

Use the hash for the build you actually ship: a debug build signed with the debug keystore has a different hash from a Play-signed release, and Play App Signing re-signs your upload with Google's key, so take the release hash from an internal-testing install rather than from a local build.

The dashboard's SMS template editor lets you paste this hash so customer-facing OTP messages always include it for production builds.

## WhatsApp zero-tap / one-tap

Nothing to configure in your app. The SDK's Android manifest contributes the receiver Meta requires plus `<queries>` for `com.whatsapp` and `com.whatsapp.w4b`, and `initiate()`/`resendOtp()` broadcast the `OTP_REQUESTED` handshake before each request. Codes arrive as `OTP_AUTO_READ` exactly like SMS ones.

What is on your side is the template: it must be an approved **authentication** template with zero-tap enabled, listing your package name and app-hash under `supported_apps`. With any one of those missing the symptom is identical and silent — the WhatsApp message arrives, the code does not fill, nothing errors. `adb logcat -s QuickAuthWaOtp` reports whether the handshake reached a visible WhatsApp install.

## Backend endpoints used

| Method | Path                              | Purpose                                            |
| ------ | --------------------------------- | -------------------------------------------------- |
| POST   | `/v1/sdk/session`                 | Mint 10-min session JWT (server-to-server only)    |
| POST   | `/v1/sdk/auth/initiate`           | Start an OTP session                               |
| POST   | `/v1/sdk/auth/verify`             | Verify a code, get JWT                             |
| POST   | `/v1/sdk/attribution/launch`      | Record launch URL + fp                             |
| POST   | `/v1/sdk/attribution/conversion`  | Record a conversion event                          |

Every authenticated POST sends `Authorization: Bearer <sessionToken>` plus an `Idempotency-Key` header. 5xx responses (and 408 / 429) retry up to `maxRetries` times with 1-2-4-second backoff; 4xx responses fail fast. A `401` triggers a single token-refresh + retry.

## Privacy (DPDP / GDPR)

- `QuickAuth.consent.set(false)` is the default. **Attribution and conversion calls drop silently** until consent is granted.
- OTP send/verify always run regardless of consent (they are service actions, not analytics).
- Device fingerprint is coarse (platform, OS version, dimensions, locale, timezone) — no IDFA, no IDFV, no MAC, no IMEI.
- The launch URL and the device token are stored locally through the configured storage adapter. `QuickAuth.auth.reset({ forgetDevice: true })` drops the device token, which is what a sign-out should do.

## Build / test

```bash
npm ci
npm run build      # builder-bob: lib/commonjs + lib/module + lib/typescript
npm test           # jest unit tests
```

The SDK version has exactly one home: `package.json`. `src/version.ts` is generated from it by `scripts/sync-version.js` (run automatically before `npm run build`, verified before `npm test`), `android/build.gradle` reads it with `JsonSlurper`, and the podspec parses it. Do not edit `src/version.ts` — run `npm version` instead.

## License

MIT © QuickAuth
