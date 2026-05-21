#import <React/RCTBridgeModule.h>

/**
 * QuickAuthRnSdk — iOS placeholder native module.
 *
 * iOS handles OTP autofill natively via `textContentType="oneTimeCode"` on
 * UITextField; the SDK's TS layer sets that prop, so this module is mostly a
 * no-op that exists for parity with the Android SmsRetriever module and
 * future expansion (e.g., Branch / iAd attribution APIs).
 */
@interface QuickAuthRnSdk : NSObject <RCTBridgeModule>
@end
