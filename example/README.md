# QuickAuth RN — Example App

A minimal app demonstrating both **headless** and **component** modes of `@quickauthin/react-native`.

## Run with React Native CLI

```bash
cd example
npm install
# iOS
npx pod-install ios
npm run ios
# Android
npm run android
```

Replace `qa_pk_test_REPLACE_ME` in `App.tsx` with your dashboard public key.

## Run with Expo (dev client required)

The SDK ships a native module (Android `SmsRetriever`), so you need a custom dev client — Expo Go won't work.

```bash
cd example
npm install
npx expo prebuild
npx expo run:ios
npx expo run:android
```

## What this demonstrates

1. `QuickAuth.init({ publicKey })` — boot the SDK
2. `QuickAuth.consent.set(true)` — opt the user in for attribution
3. `QuickAuth.attribution.captureLaunch()` — record launch URL + device fingerprint
4. `<QuickAuthLoginButton phone=… onSessionStarted=… />` — sends OTP
5. `<QuickAuthOtpField autoFillFromSms onCodeFilled=… />` — Android SMS Retriever fills the field; iOS uses native `oneTimeCode` autofill
6. `QuickAuth.auth.verifyOTP(...)` — exchange the code for a JWT
7. `QuickAuth.attribution.trackConversion({ event: 'signup' })` — write a conversion event

## Android app-hash

QuickAuth's SMS Retriever requires the SMS body to start with your app's 11-character hash. The SDK can compute it at runtime:

```ts
const hash = await QuickAuth.auth.getSmsRetrieverHash();
console.log('use this hash in your SMS template:', hash);
```
