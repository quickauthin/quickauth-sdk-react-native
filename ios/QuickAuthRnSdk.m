#import "QuickAuthRnSdk.h"

@implementation QuickAuthRnSdk

RCT_EXPORT_MODULE(QuickAuthSmsRetriever);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// iOS uses TextInput textContentType="oneTimeCode" for autofill — these are
// no-op stubs so the JS bridge layer can call them uniformly across platforms.

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(nil);
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(nil);
}

RCT_EXPORT_METHOD(getAppHash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@"");
}

// iOS bundle identifier, used to app-lock a publishable key server-side.
// Resolves an empty string instead of rejecting: a missing identity must
// degrade to an omitted header, never fail the auth request that needed it.
RCT_EXPORT_METHOD(getAppIdentity:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([[NSBundle mainBundle] bundleIdentifier] ?: @"");
}

// Required for NativeEventEmitter on RN >= 0.65.
RCT_EXPORT_METHOD(addListener:(NSString *)eventName) {}
RCT_EXPORT_METHOD(removeListeners:(double)count) {}

@end
