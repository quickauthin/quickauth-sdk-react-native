package io.quickauth.rnsdk;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The native half of QuickAuth auto-read: Google's SMS Retriever and WhatsApp's zero-tap /
 * one-tap broadcast.
 *
 * <p>Both live in one module because they are two delivery mechanisms for one thing, matched on
 * the same 11-character app hash. Codes reach JavaScript as {@code qa.sms.code} and
 * {@code qa.whatsapp.code} device events.
 *
 * <p>SMS Retriever requires the message body to end with the app hash from
 * {@link #getAppHash(Promise)}; WhatsApp requires the same hash on the approved template.
 */
public class QuickAuthSmsRetrieverModule extends ReactContextBaseJavaModule {
    private static final String TAG = "QuickAuthWaOtp";
    private static final String SMS_EVENT_NAME = "qa.sms.code";
    private static final String WHATSAPP_EVENT_NAME = "qa.whatsapp.code";

    /**
     * Keyword-anchored code, e.g. "your OTP is 483920" or "code: 4821".
     *
     * <p>Only punctuation, whitespace and a short "is"/"are" may sit between the keyword and the
     * digits. A looser gap swallows the wrong number in bodies like "Your OTP for order 4471029 is
     * 483920", where an unrelated reference number is the nearer match — there the gap fails and we
     * fall through to {@link #FALLBACK_CODE}.
     */
    private static final Pattern KEYWORD_CODE = Pattern.compile(
            "(?:otp|code|pin|password)[\\s:=.,\\-\u2013\u2014]{0,6}(?:is|are)?"
                    + "[\\s:=.,\\-\u2013\u2014]{0,6}\\b(\\d{4,8})\\b",
            Pattern.CASE_INSENSITIVE);

    /**
     * Any standalone 4–8 digit run. The word boundaries keep this off part of a longer run, so
     * 10-digit mobile numbers and 12-digit E.164 numbers are skipped rather than truncated into
     * something that looks like a plausible code.
     */
    private static final Pattern FALLBACK_CODE = Pattern.compile("\\b(\\d{4,8})\\b");

    /**
     * The 11-character app hash that terminates every SMS Retriever body. It is base64 over
     * [A-Za-z0-9+/], so it can contain a digit run flanked by '+' or '/' that reads exactly like a
     * standalone code. Strip it before scanning.
     */
    private static final Pattern APP_HASH_SUFFIX = Pattern.compile("\\s+[A-Za-z0-9+/]{11}\\s*$");

    /** Google's app hash is 9 bytes of the digest, base64-encoded to 11 characters. */
    private static final int NUM_HASHED_BYTES = 9;
    private static final int NUM_BASE64_CHARS = 11;

    /** Meta's handshake action, broadcast to WhatsApp before the template is sent. */
    private static final String ACTION_OTP_REQUESTED = "com.whatsapp.otp.OTP_REQUESTED";

    /** Meta's name for the caller-identity PendingIntent. */
    private static final String EXTRA_CALLER_IDENTITY = "_ci_";

    /**
     * Consumer WhatsApp and WhatsApp Business — the code arrives on whichever is installed.
     * Mirrored by {@code <queries>} in the SDK manifest; both lists must change together.
     */
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

    /**
     * Every app hash valid for this install — one per signing certificate.
     *
     * <p>An app that has rotated its signing key (v3) has more than one, and every one of them has
     * to be registered with the OTP sender or messages to devices holding the other certificate
     * are never delivered.
     */
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

    /**
     * Attach the bridge to the manifest-declared receiver, flushing any code it is holding from
     * before JavaScript was listening.
     */
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
     * Tell WhatsApp a code is about to be requested, and that this app may receive it.
     *
     * <p>Zero-tap does not work without this, and nothing says so. Meta requires the app to
     * broadcast a handshake BEFORE the template is sent. Without it WhatsApp receives the message
     * and shows it, and simply never broadcasts the code. Every other check can pass — template
     * approved, package matching, signing hash matching, receiver declared — and the OTP still does
     * not auto-fill, with no error anywhere to explain it.
     *
     * <p>The {@link PendingIntent} in {@code _ci_} is how WhatsApp identifies the caller. It
     * carries no action and is never sent; WhatsApp reads the creator's identity off it, which is
     * why it must be immutable — a mutable one would let another app fill it in.
     *
     * <p>Broadcast to both WhatsApp and WhatsApp Business, because the user's code arrives on
     * whichever they have. Sending to a package that is not installed is a no-op rather than an
     * error, so there is nothing to check first.
     *
     * <p>Never rejects: a missing handshake costs auto-read, not the login.
     */
    @ReactMethod
    public void sendWhatsAppOtpHandshake(final Promise promise) {
        try {
            Context ctx = reactContext.getApplicationContext();
            String requestId = UUID.randomUUID().toString();

            // No action and FLAG_IMMUTABLE: this is an identity token, not something to fire.
            // FLAG_IMMUTABLE only exists from API 23; below that the bit is simply not set, which
            // is the platform's own pre-23 behaviour rather than a downgrade we chose.
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent identity = PendingIntent.getBroadcast(ctx, 0, new Intent(), flags);

            // Which WhatsApp packages this app can actually see. On API 30+ an invisible package
            // swallows the broadcast silently, so reporting it is the difference between
            // diagnosing that in one log line and chasing the template for a day.
            List<String> visible = new ArrayList<>();
            for (String pkg : WHATSAPP_PACKAGES) {
                try {
                    ctx.getPackageManager().getPackageInfo(pkg, 0);
                    visible.add(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // Not installed, or not visible to us.
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
                // Either WhatsApp is not installed, or <queries> is missing from the merged
                // manifest. Both mean the handshake reached nobody and zero-tap cannot work.
                Log.w(TAG, "WhatsApp OTP handshake sent but NO WhatsApp package is visible — "
                        + "not installed, or <queries> missing from the merged manifest");
            } else {
                Log.d(TAG, "WhatsApp OTP handshake sent to " + visible
                        + " (requestId=" + requestId + ")");
            }
            promise.resolve(requestId);
        } catch (Throwable t) {
            // Never fail the OTP request over this. The user can still read the code and type it.
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

    @Override
    public void onCatalystInstanceDestroy() {
        unregisterReceiver();
        detachWhatsAppListener();
        super.onCatalystInstanceDestroy();
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
     * Pull the OTP out of an SMS body.
     *
     * <p>This was {@code find()} over a bare {@code \b(\d{4,8})\b}, which returned the FIRST digit
     * run in the message — so "Your OTP for order 4471029 is 483920" auto-filled the order number
     * and the user watched the wrong code appear in the field, then watched it be rejected.
     *
     * <p>Prefers a keyword-anchored match; otherwise takes the LAST standalone run. Last, not
     * first: senders put reference numbers, order ids and amounts ahead of the code far more often
     * than after it. Mirrors the Flutter and Android SDKs, which fixed the same bug.
     *
     * <p>Package-private so it can be exercised directly if a JVM test source set is ever added to
     * this module.
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
     * Every app hash valid for this install.
     *
     * <p>Two things were wrong with the path this replaces. It asked for {@code GET_SIGNATURES},
     * deprecated since API 28 and flagged by Play's pre-launch report because it reports only the
     * oldest certificate of an app that has rotated its signing key — so a rotated app computed a
     * hash no current device would match. And it took only the first signature, which for a
     * rotated app is the one that is no longer in use.
     *
     * <p>On API 28+ this reads {@code signingInfo}: {@code apkContentsSigners} for the certificate
     * that actually signed the installed APK, plus the rotation history, so every hash a device
     * might present is returned. Pre-28 there is no alternative and the deprecated call remains,
     * where it is also correct — key rotation did not exist before API 28.
     *
     * <p>The hashed string is {@code "<package> <cert.toCharsString()>"}, per Google's
     * AppSignatureHelper: the hash covers the certificate's string form, not a digest of its
     * bytes. Nine bytes of the SHA-256, base64 with no padding, truncated to 11 characters.
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
                // Rotation history exists only for a single-signer app; the platform returns
                // null for a multi-signer one, which has no rotation to describe.
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
