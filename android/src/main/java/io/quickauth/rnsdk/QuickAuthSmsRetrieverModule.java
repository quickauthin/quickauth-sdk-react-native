package io.quickauth.rnsdk;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Build;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import com.google.android.gms.auth.api.phone.SmsRetriever;
import com.google.android.gms.auth.api.phone.SmsRetrieverClient;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Status;

import java.security.MessageDigest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wraps the Google Play SMS Retriever API. Emits the parsed code as a
 * `qa.sms.code` device event so the JS side can autofill OTP fields.
 *
 * Note: SMS Retriever requires the SMS body to start with the 11-character
 * app-hash (computed from the package name + signing certificate). Use
 * `getAppHash()` from JS during onboarding to surface the correct hash to
 * customers configuring their backend templates.
 */
public class QuickAuthSmsRetrieverModule extends ReactContextBaseJavaModule {
    private static final String EVENT_NAME = "qa.sms.code";
    private static final Pattern OTP_PATTERN = Pattern.compile("\\b(\\d{4,8})\\b");

    private final ReactApplicationContext reactContext;
    private BroadcastReceiver receiver;
    private boolean registered = false;

    public QuickAuthSmsRetrieverModule(ReactApplicationContext context) {
        super(context);
        this.reactContext = context;
    }

    @NonNull
    @Override
    public String getName() {
        return "QuickAuthSmsRetriever";
    }

    @ReactMethod
    public void start(final Promise promise) {
        try {
            Activity activity = getCurrentActivity();
            Context ctx = activity != null ? activity : reactContext;

            SmsRetrieverClient client = SmsRetriever.getClient(ctx);
            client.startSmsRetriever()
                    .addOnSuccessListener(unused -> {
                        registerReceiver(ctx);
                        promise.resolve(null);
                    })
                    .addOnFailureListener(e -> promise.reject("E_SMS_RETRIEVER_START", e));
        } catch (Exception e) {
            promise.reject("E_SMS_RETRIEVER_START", e);
        }
    }

    @ReactMethod
    public void stop(final Promise promise) {
        unregisterReceiver();
        promise.resolve(null);
    }

    @ReactMethod
    public void getAppHash(final Promise promise) {
        try {
            String hash = computeAppHash();
            promise.resolve(hash);
        } catch (Exception e) {
            promise.reject("E_APP_HASH", e);
        }
    }

    // RN >= 0.65 requires explicit add/remove listener stubs to silence warnings.
    @ReactMethod public void addListener(String eventName) {}
    @ReactMethod public void removeListeners(Integer count) {}

    @Override
    public void onCatalystInstanceDestroy() {
        unregisterReceiver();
        super.onCatalystInstanceDestroy();
    }

    private void registerReceiver(Context ctx) {
        if (registered) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!SmsRetriever.SMS_RETRIEVED_ACTION.equals(intent.getAction())) return;
                Bundle extras = intent.getExtras();
                if (extras == null) return;
                Status status = (Status) extras.get(SmsRetriever.EXTRA_STATUS);
                if (status == null || status.getStatusCode() != CommonStatusCodes.SUCCESS) return;
                String message = (String) extras.get(SmsRetriever.EXTRA_SMS_MESSAGE);
                if (message == null) return;
                Matcher m = OTP_PATTERN.matcher(message);
                String code = m.find() ? m.group(1) : null;
                if (code == null) return;
                WritableMap params = Arguments.createMap();
                params.putString("code", code);
                params.putString("message", message);
                reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                        .emit(EVENT_NAME, params);
            }
        };
        IntentFilter filter = new IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            ctx.registerReceiver(receiver, filter);
        }
        registered = true;
    }

    private void unregisterReceiver() {
        if (!registered || receiver == null) return;
        try {
            reactContext.unregisterReceiver(receiver);
        } catch (Exception ignored) {}
        receiver = null;
        registered = false;
    }

    @SuppressWarnings("deprecation")
    private String computeAppHash() throws Exception {
        Context ctx = reactContext.getApplicationContext();
        String packageName = ctx.getPackageName();
        android.content.pm.PackageManager pm = ctx.getPackageManager();
        android.content.pm.Signature[] signatures =
                pm.getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNATURES).signatures;
        if (signatures == null || signatures.length == 0) return "";

        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update((packageName + " " + signatures[0].toCharsString()).getBytes("UTF-8"));
        byte[] hash = md.digest();
        // Take 9 bytes -> 11 base64 chars (drop padding).
        byte[] truncated = new byte[9];
        System.arraycopy(hash, 0, truncated, 0, 9);
        String base64 = android.util.Base64.encodeToString(
                truncated, android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
        return base64.substring(0, Math.min(11, base64.length()));
    }
}
