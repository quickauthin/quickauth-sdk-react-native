#import <React/RCTBridgeModule.h>

/**
 * iOS counterpart of the Android SMS Retriever module. OTP autofill uses
 * textContentType="oneTimeCode", so most methods are no-ops.
 */
@interface QuickAuthRnSdk : NSObject <RCTBridgeModule>
@end
