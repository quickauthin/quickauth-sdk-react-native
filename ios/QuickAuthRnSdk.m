#import "QuickAuthRnSdk.h"

@implementation QuickAuthRnSdk

RCT_EXPORT_MODULE(QuickAuthSmsRetriever);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// bundleId is sent as X-QuickAuth-Bundle; version fields go in deviceInfo.
- (NSDictionary *)constantsToExport {
  NSBundle *bundle = [NSBundle mainBundle];
  NSMutableDictionary *constants = [NSMutableDictionary dictionary];
  if (bundle.bundleIdentifier) constants[@"bundleId"] = bundle.bundleIdentifier;
  NSString *version = bundle.infoDictionary[@"CFBundleShortVersionString"];
  NSString *build = bundle.infoDictionary[@"CFBundleVersion"];
  if (version) constants[@"appVersion"] = version;
  if (build) constants[@"appBuild"] = build;
  return constants;
}

// No-op stubs; iOS autofill uses textContentType="oneTimeCode".

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

// Required for NativeEventEmitter on RN >= 0.65.
RCT_EXPORT_METHOD(addListener:(NSString *)eventName) {}
RCT_EXPORT_METHOD(removeListeners:(double)count) {}

@end
