package io.quickauth.rnsdk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.text.TextUtils;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Receives WhatsApp zero-tap/one-tap codes. Manifest-declared so it works when the app isn't
 * running; codes are held until JS subscribes. Exported without a permission, per Meta's docs.
 */
public class WhatsAppOtpReceiver extends BroadcastReceiver {

    private static final String TAG = "QuickAuthWaOtp";

    /** Must match the action in AndroidManifest.xml. */
    public static final String ACTION_OTP_RETRIEVED = "com.whatsapp.otp.OTP_RETRIEVED";

    /** Already-extracted code. */
    public static final String EXTRA_CODE = "code";

    public static final String EXTRA_REQUEST_ID = "request_id";

    /** 4-10 digits; looser than 4-8 since Meta lets merchants pick the length. */
    private static final Pattern PLAUSIBLE_CODE = Pattern.compile("^[0-9]{4,10}$");

    /** Notified when a code arrives. */
    public interface Listener {
        void onCode(String code);
    }

    private static final Object LOCK = new Object();

    /** Code received before any listener attached. Newer code replaces older. */
    private static String pending = null;

    /** List, not a single slot: OTP service and observeOTP can both be subscribed at once. */
    private static final List<Listener> listeners = new ArrayList<>();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_OTP_RETRIEVED.equals(intent.getAction())) return;

        String code = intent.getStringExtra(EXTRA_CODE);
        code = code == null ? null : code.trim();
        if (TextUtils.isEmpty(code)) {
            Log.w(TAG, "WhatsApp OTP broadcast carried no code");
            return;
        }

        // Sanity check only. WhatsApp's package/signing-hash match is the security boundary.
        if (!PLAUSIBLE_CODE.matcher(code).matches()) {
            Log.w(TAG, "WhatsApp OTP broadcast carried an implausible code; ignoring");
            return;
        }

        Log.d(TAG, "WhatsApp OTP received (" + code.length() + " chars)");
        deliver(code);
    }

    /** Deliver to listeners, or hold if none. */
    public static void deliver(String code) {
        List<Listener> targets;
        synchronized (LOCK) {
            if (listeners.isEmpty()) {
                pending = code;
                return;
            }
            targets = new ArrayList<>(listeners);
        }
        // Isolate listener failures.
        for (Listener target : targets) {
            try {
                target.onCode(code);
            } catch (Throwable t) {
                Log.w(TAG, "WhatsApp OTP listener threw", t);
            }
        }
    }

    /** Consumes the pending code so a re-subscribe doesn't replay it. */
    public static void addListener(Listener listener) {
        String held;
        synchronized (LOCK) {
            listeners.add(listener);
            held = pending;
            pending = null;
        }
        if (held == null) return;
        try {
            listener.onCode(held);
        } catch (Throwable t) {
            Log.w(TAG, "WhatsApp OTP listener threw on flush", t);
        }
    }

    public static void removeListener(Listener listener) {
        synchronized (LOCK) {
            listeners.remove(listener);
        }
    }

    /** Call on each new OTP request so a stale code isn't delivered. */
    public static void clearPending() {
        synchronized (LOCK) {
            pending = null;
        }
    }
}
