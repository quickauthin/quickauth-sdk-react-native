package io.quickauth.rnsdk;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import com.google.android.gms.auth.api.phone.SmsRetriever;
import com.google.android.gms.auth.api.phone.SmsRetrieverClient;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Status;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * OTP auto-read via SMS Retriever and WhatsApp zero-tap/one-tap. Both match on the same app hash.
 * Emits {@code qa.sms.code} and {@code qa.whatsapp.code}.
 */
public class QuickAuthSmsRetrieverModule extends ReactContextBaseJavaModule {
    private static final String TAG = "QuickAuthWaOtp";
    private static final String SMS_EVENT_NAME = "qa.sms.code";
    private static final String WHATSAPP_EVENT_NAME = "qa.whatsapp.code";

    /**
     * Keyword-anchored code, e.g. "your OTP is 483920" or "code: 4821". Gap is kept tight so
     * "OTP for order 4471029 is 483920" doesn't match the order number.
     */
    private static final Pattern KEYWORD_CODE = Pattern.compile(
            "(?:otp|code|pin|password)[\\s:=.,\\-\u2013\u2014]{0,6}(?:is|are)?"
                    + "[\\s:=.,\\-\u2013\u2014]{0,6}\\b(\\d{4,8})\\b",
            Pattern.CASE_INSENSITIVE);

    /** Standalone 4-8 digit run. Word boundaries skip longer runs like phone numbers. */
    private static final Pattern FALLBACK_CODE = Pattern.compile("\\b(\\d{4,8})\\b");

    /** Trailing 11-char app hash. Base64, so it can contain digit runs; strip before scanning. */
    private static final Pattern APP_HASH_SUFFIX = Pattern.compile("\\s+[A-Za-z0-9+/]{11}\\s*$");

    /** App hash: first 9 bytes of SHA-256, base64 to 11 chars. */
    private static final int NUM_HASHED_BYTES = 9;
    private static final int NUM_BASE64_CHARS = 11;

    private static final String ACTION_OTP_REQUESTED = "com.whatsapp.otp.OTP_REQUESTED";

    /** Caller-identity PendingIntent extra. */
    private static final String EXTRA_CALLER_IDENTITY = "_ci_";

    /** Keep in sync with {@code <queries>} in AndroidManifest.xml. */
    private static final List<String> WHATSAPP_PACKAGES =
            Arrays.asList("com.whatsapp", "com.whatsapp.w4b");

    private final ReactApplicationContext reactContext;
    private BroadcastReceiver receiver;
    private boolean registered = false;
    private WhatsAppOtpReceiver.Listener whatsAppListener;

    public QuickAuthSmsRetrieverModule(ReactApplicationContext context) {
        super(context);
        this.reactContext = context;
    }

    @NonNull
    @Override
    public String getName() {
        return "QuickAuthSmsRetriever";
    }

    /** packageName is sent as X-QuickAuth-Package; version fields go in deviceInfo. */
    @Override
    public Map<String, Object> getConstants() {
        final Map<String, Object> constants = new HashMap<>();
        final String pkg = reactContext.getPackageName();
        constants.put("packageName", pkg);
        try {
            PackageInfo info = reactContext.getPackageManager().getPackageInfo(pkg, 0);
            if (info.versionName != null) constants.put("appVersion", info.versionName);
            long build = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
            constants.put("appBuild", String.valueOf(build));
        } catch (PackageManager.NameNotFoundException ignored) {
            // Can't happen for our own package.
        }
        return constants;
    }

    // -- SMS Retriever ------------------------------------------------------

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
            List<String> hashes = computeAppHashes();
            promise.resolve(hashes.isEmpty() ? "" : hashes.get(0));
        } catch (Exception e) {
            promise.reject("E_APP_HASH", e);
        }
    }

    /** One hash per signing cert. Apps with rotated keys have several; register all of them. */
    @ReactMethod
    public void getAppHashes(final Promise promise) {
        try {
            WritableArray out = Arguments.createArray();
            for (String hash : computeAppHashes()) out.pushString(hash);
            promise.resolve(out);
        } catch (Exception e) {
            promise.reject("E_APP_HASH", e);
        }
    }

    // -- WhatsApp zero-tap / one-tap ---------------------------------------

    /** Subscribe to WhatsAppOtpReceiver; any held code is flushed on attach. */
    @ReactMethod
    public void startWhatsAppOtpListener(final Promise promise) {
        if (whatsAppListener == null) {
            whatsAppListener = code -> {
                WritableMap params = Arguments.createMap();
                params.putString("code", code);
                emit(WHATSAPP_EVENT_NAME, params);
            };
            WhatsAppOtpReceiver.addListener(whatsAppListener);
        }
        promise.resolve(null);
    }

    @ReactMethod
    public void stopWhatsAppOtpListener(final Promise promise) {
        detachWhatsAppListener();
        promise.resolve(null);
    }

    /**
     * Handshake must be sent before the OTP request or WhatsApp won't broadcast the code.
     * Never rejects; failure only loses auto-read.
     */
    @ReactMethod
    public void sendWhatsAppOtpHandshake(final Promise promise) {
        try {
            Context ctx = reactContext.getApplicationContext();
            String requestId = UUID.randomUUID().toString();

            // Identity token only, never sent. Must be immutable (API 23+).
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent identity = PendingIntent.getBroadcast(ctx, 0, new Intent(), flags);

            // For logging only. API 30+ needs <queries> to see these packages.
            List<String> visible = new ArrayList<>();
            for (String pkg : WHATSAPP_PACKAGES) {
                try {
                    ctx.getPackageManager().getPackageInfo(pkg, 0);
                    visible.add(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // Not installed or not visible.
                }
            }

            for (String pkg : WHATSAPP_PACKAGES) {
                Intent intent = new Intent(ACTION_OTP_REQUESTED)
                        .setPackage(pkg)
                        .putExtra(EXTRA_CALLER_IDENTITY, identity)
                        .putExtra(WhatsAppOtpReceiver.EXTRA_REQUEST_ID, requestId);
                ctx.sendBroadcast(intent);
            }

            if (visible.isEmpty()) {
                Log.w(TAG, "WhatsApp OTP handshake sent but NO WhatsApp package is visible — "
                        + "not installed, or <queries> missing from the merged manifest");
            } else {
                Log.d(TAG, "WhatsApp OTP handshake sent to " + visible
                        + " (requestId=" + requestId + ")");
            }
            promise.resolve(requestId);
        } catch (Throwable t) {
            // Don't fail the OTP request; user can still type the code.
            Log.w(TAG, "WhatsApp OTP handshake failed: " + t.getMessage());
            promise.resolve(null);
        }
    }

    @ReactMethod
    public void clearWhatsAppOtp(final Promise promise) {
        WhatsAppOtpReceiver.clearPending();
        promise.resolve(null);
    }

    // RN >= 0.65 requires explicit add/remove listener stubs to silence warnings.
    @ReactMethod public void addListener(String eventName) {}
    @ReactMethod public void removeListeners(Integer count) {}

    // Use invalidate(), not onCatalystInstanceDestroy(); the latter isn't called in bridgeless mode.
    @Override
    public void invalidate() {
        unregisterReceiver();
        detachWhatsAppListener();
        super.invalidate();
    }

    // -- Internals ----------------------------------------------------------

    private void emit(String event, WritableMap params) {
        if (!reactContext.hasActiveCatalystInstance()) return;
        reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(event, params);
    }

    private void detachWhatsAppListener() {
        if (whatsAppListener == null) return;
        WhatsAppOtpReceiver.removeListener(whatsAppListener);
        whatsAppListener = null;
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
                String code = extractCode(message);
                if (code.isEmpty()) return;
                WritableMap params = Arguments.createMap();
                params.putString("code", code);
                params.putString("message", message);
                emit(SMS_EVENT_NAME, params);
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

    /**
     * Prefer keyword-anchored match, else last 4-8 digit run (reference numbers usually come first).
     * Keep in sync with the Flutter and Android SDKs. Package-private for tests.
     */
    static String extractCode(String body) {
        if (body == null) return "";
        String stripped = APP_HASH_SUFFIX.matcher(body).replaceAll("");

        String last = "";
        Matcher keyed = KEYWORD_CODE.matcher(stripped);
        while (keyed.find()) last = keyed.group(1);
        if (!last.isEmpty()) return last;

        Matcher runs = FALLBACK_CODE.matcher(stripped);
        while (runs.find()) last = runs.group(1);
        return last;
    }

    /**
     * API 28+: current signers plus rotated signing certs. Pre-28 falls back to GET_SIGNATURES
     * (no key rotation there).
     */
    private List<String> computeAppHashes() throws Exception {
        Context ctx = reactContext.getApplicationContext();
        String packageName = ctx.getPackageName();
        PackageManager pm = ctx.getPackageManager();

        List<Signature> signatures = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo info =
                    pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                            .signingInfo;
            if (info != null) {
                Signature[] current = info.getApkContentsSigners();
                if (current != null) signatures.addAll(Arrays.asList(current));
                // History is null for multi-signer apps.
                if (!info.hasMultipleSigners()) {
                    Signature[] history = info.getSigningCertificateHistory();
                    if (history != null) {
                        for (Signature past : history) {
                            if (!signatures.contains(past)) signatures.add(past);
                        }
                    }
                }
            }
        } else {
            @SuppressWarnings("deprecation")
            Signature[] legacy =
                    pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures;
            if (legacy != null) signatures.addAll(Arrays.asList(legacy));
        }

        List<String> hashes = new ArrayList<>(signatures.size());
        for (Signature signature : signatures) {
            hashes.add(computeAppHash(packageName, signature.toCharsString()));
        }
        return hashes;
    }

    /** Google's AppSignatureHelper algorithm. {@code signature} is toCharsString(), not a digest. */
    static String computeAppHash(String packageName, String signature) throws Exception {
        String appInfo = packageName + " " + signature;
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update(appInfo.getBytes("UTF-8"));
        byte[] hash = md.digest();
        byte[] truncated = new byte[NUM_HASHED_BYTES];
        System.arraycopy(hash, 0, truncated, 0, NUM_HASHED_BYTES);
        String base64 = Base64.encodeToString(truncated, Base64.NO_PADDING | Base64.NO_WRAP);
        return base64.substring(0, Math.min(NUM_BASE64_CHARS, base64.length()));
    }
}
