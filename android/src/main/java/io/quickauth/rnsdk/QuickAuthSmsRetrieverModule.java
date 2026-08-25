package io.quickauth.rnsdk;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;
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

    /**
     * WhatsApp codes go on their own event, not on the SMS one.
     *
     * <p>The SMS event carries a whole message body for JS to parse; WhatsApp hands over the
     * code itself. Putting both on one event would mean the JS side could not tell a body from
     * a code without inspecting it, and every existing listener would start receiving a shape
     * it was never written for.
     */
    private static final String WA_EVENT_NAME = "qa.whatsapp.code";

    /** Meta's handshake action, broadcast to WhatsApp before the template is sent. */
    private static final String ACTION_OTP_REQUESTED = "com.whatsapp.otp.OTP_REQUESTED";

    /** Consumer WhatsApp and WhatsApp Business — the code arrives on whichever is installed. */
    private static final String[] WHATSAPP_PACKAGES = { "com.whatsapp", "com.whatsapp.w4b" };
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
    /**
     * Start forwarding WhatsApp zero-tap / one-tap codes to JS.
     *
     * <p>Attaching also flushes anything the receiver caught while JS was not running — the
     * zero-tap case this whole path exists for.
     */
    @ReactMethod
    public void startWhatsAppOtp(final Promise promise) {
        try {
            WhatsAppOtpReceiver.setListener(new WhatsAppOtpReceiver.Listener() {
                @Override
                public void onCode(String code) {
                    WritableMap params = Arguments.createMap();
                    params.putString("code", code);
                    getReactApplicationContext()
                            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                            .emit(WA_EVENT_NAME, params);
                }
            });
            promise.resolve(true);
        } catch (Throwable t) {
            promise.resolve(false);
        }
    }

    /** Stop forwarding, so a torn-down listener does not keep a JS callback alive. */
    @ReactMethod
    public void stopWhatsAppOtp(final Promise promise) {
        WhatsAppOtpReceiver.setListener(null);
        promise.resolve(true);
    }

    /**
     * Drop any code held natively from an earlier attempt.
     *
     * <p>Called when requesting a fresh OTP. Without it a code that arrived after the user gave
     * up on a previous attempt would be delivered against the new request and fail verification
     * for reasons they cannot see.
     */
    @ReactMethod
    public void clearWhatsAppOtp(final Promise promise) {
        WhatsAppOtpReceiver.clearPending();
        promise.resolve(true);
    }

    /**
     * Tell WhatsApp a code is about to be requested, and that this app may receive it.
     *
     * <p>Zero-tap does not work without this, and nothing says so. Meta requires the handshake
     * to be broadcast BEFORE the authentication template is sent — without it WhatsApp receives
     * the message, shows it, and never broadcasts the code. Every other check can pass and the
     * OTP still does not auto-fill, with no error anywhere.
     *
     * <p>The PendingIntent in {@code _ci_} is how WhatsApp identifies the caller. It carries no
     * action and is never fired; WhatsApp reads the creator's identity off it, which is why it
     * must be immutable.
     *
     * <p>Sent per request rather than once at startup, because Meta expires it after ten
     * minutes.
     */
    @ReactMethod
    public void sendWhatsAppOtpHandshake(final Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            String requestId = java.util.UUID.randomUUID().toString();

            PendingIntent identity = PendingIntent.getBroadcast(
                    ctx, 0, new Intent(),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            // Which WhatsApp packages this app can actually see. On API 30+ an invisible
            // package swallows the broadcast silently, so reporting it is the difference
            // between diagnosing that in one log line and chasing the template for a day.
            java.util.List<String> visible = new java.util.ArrayList<>();
            for (String pkg : WHATSAPP_PACKAGES) {
                try {
                    ctx.getPackageManager().getPackageInfo(pkg, 0);
                    visible.add(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // not installed, or not visible to us
                }
            }

            for (String pkg : WHATSAPP_PACKAGES) {
                Intent intent = new Intent(ACTION_OTP_REQUESTED).setPackage(pkg);
                intent.putExtra("_ci_", identity);
                intent.putExtra("request_id", requestId);
                ctx.sendBroadcast(intent);
            }

            if (visible.isEmpty()) {
                Log.w(WhatsAppOtpReceiver.TAG, "WhatsApp OTP handshake sent but NO WhatsApp "
                        + "package is visible — not installed, or <queries> missing from the "
                        + "merged manifest");
            } else {
                Log.d(WhatsAppOtpReceiver.TAG,
                        "WhatsApp OTP handshake sent to " + visible + " (requestId=" + requestId + ")");
            }
            promise.resolve(requestId);
        } catch (Throwable t) {
            // Never fail the OTP request over this. A missing handshake costs auto-read, not
            // the login — the user can still read the code and type it.
            Log.w(WhatsAppOtpReceiver.TAG, "WhatsApp OTP handshake failed: " + t.getMessage());
            promise.resolve(null);
        }
    }

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
