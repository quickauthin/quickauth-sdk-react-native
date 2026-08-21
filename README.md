# @quickauth/react-native

Phone OTP authentication + WhatsApp marketing attribution for React Native.

- Send + verify OTP over **SMS** or **WhatsApp**
- Android SMS auto-read via Google Play **SMS Retriever** (no `READ_SMS` permission)
- iOS OTP autofill via native `textContentType="oneTimeCode"` — zero config
- WhatsApp deep-link login via `Linking`
- Attribution capture from launch URL (`utm_*`, `qa_clid`, `gclid`, `fbclid`, …)
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

### Optional: persist attribution across launches

```bash
npm install @react-native-async-storage/async-storage
```

If `@react-native-async-storage/async-storage` is installed, the SDK uses it; otherwise it falls back to in-memory storage. Both work — the only difference is whether attribution survives a cold launch.

## Auth model

Pick exactly one auth mode at `init()`:

| Mode | Config | When |
| ---- | ------ | ---- |
| Publishable key | `publishableKey: 'pk_live_…'` | Zero-backend quick start |
| Session token | `onTokenExpiry: async () => …` | You want server-minted, short-lived tokens |

Passing neither — or both — throws at `init()`.

### Publishable key (zero-backend)

```ts
await QuickAuth.init({ publishableKey: 'pk_live_…' });
```

A publishable key is designed to ship inside the binary: on the backend it is scoped to OTP initiate/verify only, locked to your registered app identity, and rate-limited. The SDK sends it as `X-QuickAuth-Key` and never mints or attaches a session token.

To support that app-locking, the SDK also sends the host app's identity — `X-QuickAuth-Package: <applicationId>` on Android, `X-QuickAuth-Bundle: <bundleIdentifier>` on iOS. This is strictly best-effort: if the identity cannot be read the header is omitted and the request still goes out, because a missing header must never fail the OTP a user is waiting on.

### Session tokens (extra-hardened)

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

```ts
import QuickAuth, { OtpChannel } from '@quickauth/react-native';

await QuickAuth.init({
  onTokenExpiry: async () => {
    const r = await fetch('https://my-app.com/api/quickauth-token');
    return (await r.json()).sessionToken;
  },
});
QuickAuth.consent.set(true); // call this AFTER your in-app consent dialog

// 1. Capture launch attribution (deep-link UTM / click IDs)
await QuickAuth.attribution.captureLaunch();

// 2. Send OTP
const session = await QuickAuth.auth.startOTP({
  phone: '+919876543210',
  channel: OtpChannel.AUTO, // auto, sms, whatsapp
});

// 3. (Android only) auto-fill from SMS Retriever
const sub = QuickAuth.auth.observeOTP((code) => {
  console.log('autofilled OTP', code);
});

// 4. Verify
const { verified, requestId } = await QuickAuth.auth.verifyOTP({
  sessionId: session.sessionId,
  code: '123456',
});
sub.remove();

// 5. Forward `requestId` to YOUR backend, which confirms with QuickAuth
//    via GET /v1/auth/status?requestId=... and mints its own session JWT.
//    QuickAuth is verification-only — your backend owns the session.
//    See https://quickauth.in/docs/backend

// 6. Track conversion
await QuickAuth.attribution.trackConversion({
  event: 'signup',
  value: 0,
  currency: 'INR',
});

// WhatsApp deep-link login
await QuickAuth.auth.startWhatsAppLogin({ businessNumber: '+919574980048' });
```

## Quick start — components

```tsx
import {
  QuickAuthLoginButton,
  QuickAuthOtpField,
} from '@quickauth/react-native';

<QuickAuthLoginButton
  phone="+919876543210"
  text="Continue"
  onSessionStarted={(sessionId) => setSessionId(sessionId)}
  onError={(err) => setError(err.message)}
/>

<QuickAuthOtpField
  value={code}
  onChangeText={setCode}
  digitCount={6}
  autoFillFromSms                 // Android SMS Retriever
  onCodeFilled={(code) => verify(code)}
/>
```

`<QuickAuthOtpField/>` renders a 6-cell OTP field whose hidden TextInput sets `textContentType="oneTimeCode"` (iOS) and `autoComplete="sms-otp"` (Android), so OS-level autofill works alongside the explicit Android SMS Retriever path.

## Public API

```ts
QuickAuth.init({
  publishableKey,   // 'pk_live_…' — zero-backend mode
  onTokenExpiry,    // async () => Promise<string> — session-token mode; exactly one of the two
  initialToken?,    // optional pre-warmed token for the very first request
  unsafe?,          // { clientId, clientSecret } — trusted-enterprise only
  apiBaseUrl?,
  maxRetries?,
  requestTimeoutMs?,
  silent?,
})
QuickAuth.isInitialised(): boolean

QuickAuth.consent.set(granted: boolean)
QuickAuth.consent.get(): boolean

QuickAuth.auth.startOTP({ phone, channel?, locale?, metadata? }): Promise<OtpSession>
QuickAuth.auth.verifyOTP({ sessionId, code }): Promise<OtpVerifyResult>
QuickAuth.auth.observeOTP((code) => void): OtpSubscription
QuickAuth.auth.startWhatsAppLogin({ businessNumber, message? }): Promise<void>
QuickAuth.auth.getSmsRetrieverHash(): Promise<string | null>

QuickAuth.attribution.captureLaunch(): Promise<AttributionPayload>
QuickAuth.attribution.capture(url: string | null): Promise<AttributionPayload>
QuickAuth.attribution.trackConversion({ event, value?, currency?, attributes? })
QuickAuth.attribution.getFingerprint(): DeviceFingerprint
QuickAuth.attribution.getFingerprintHash(): string
QuickAuth.attribution.getLastAttribution(): AttributionPayload | null
```

## Android app-hash

For SMS Retriever to capture an OTP, the SMS body must start with your app's 11-character hash. Get it at runtime:

```ts
const hash = await QuickAuth.auth.getSmsRetrieverHash();
// Send `hash` to your SMS template generator
```

The dashboard's SMS template editor lets you paste this hash so customer-facing OTP messages always include it for production builds.

## Backend endpoints used

| Method | Path                              | Purpose                                            |
| ------ | --------------------------------- | -------------------------------------------------- |
| POST   | `/v1/sdk/session`                 | Mint 10-min session JWT (server-to-server only)    |
| POST   | `/v1/sdk/auth/initiate`           | Start an OTP session                               |
| POST   | `/v1/sdk/auth/verify`             | Verify a code, get JWT                             |
| POST   | `/v1/sdk/attribution/launch`      | Record launch URL + fp                             |
| POST   | `/v1/sdk/attribution/conversion`  | Record a conversion event                          |

Every authenticated POST sends either `X-QuickAuth-Key: <publishableKey>` (plus the app identity header) or `Authorization: Bearer <sessionToken>`, along with an `Idempotency-Key` header. 5xx responses and `408` retry up to `maxRetries` times with 1-2-4-second backoff; every other 4xx fails fast. **`429` is never retried** — the backend has already told us it is over capacity for this caller, so backing off blindly into it only adds load; honour the limit and surface the error. A `401` triggers a single token-refresh and replays the *same* request, reusing the original `Idempotency-Key` and the remaining retry budget, so a replayed OTP send deduplicates server-side instead of dispatching a second message.

## Privacy (DPDP / GDPR)

- `QuickAuth.consent.set(false)` is the default. **Attribution and conversion calls drop silently** until consent is granted.
- OTP send/verify always run regardless of consent (they are service actions, not analytics).
- Device fingerprint is coarse (platform, OS version, dimensions, locale, timezone) — no IDFA, no IDFV, no MAC, no IMEI.
- The launch URL is stored locally via AsyncStorage when available — clear it by calling `QuickAuth.consent.set(false)` and reinstalling, or implement your own privacy reset on top.

## Build / test

```bash
npm install
npm run build      # builder-bob: lib/commonjs + lib/module + lib/typescript
npm test           # jest unit tests
```

## License

MIT © QuickAuth
