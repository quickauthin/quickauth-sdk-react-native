package io.quickauth.rnsdk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.util.regex.Pattern;

/**
 * Receives a WhatsApp zero-tap or one-tap authentication code.
 *
 * <p>WhatsApp does not deliver these over SMS. It broadcasts the code to the app named in the
 * template's {@code supported_apps}, matched on package name and the 11-character signing
 * hash, so SmsRetriever never sees it — the two are different delivery channels that happen to
 * share the same app hash.
 *
 * <p>Declared in the manifest rather than registered at runtime. Zero-tap's promise is that the
 * user does nothing, which means the code can arrive while the app is backgrounded or not
 * running at all, and a runtime receiver only exists once the app already does. That in turn
 * means the code can arrive with no JS listener attached, so it is held here and flushed the
 * moment one appears.
 */
public class WhatsAppOtpReceiver extends BroadcastReceiver {

    static final String TAG = "QuickAuthWaOtp";

    /**
     * WhatsApp's broadcast contract. Both zero-tap and one-tap arrive this way — one-tap is the
     * same delivery with a user tap in front of it — so one receiver serves both.
     *
     * <p>A wrong value here fails in the worst way available: the broadcast is never matched,
     * nothing throws, and the OTP silently does not arrive.
     */
    public static final String ACTION_OTP_RETRIEVED = "com.whatsapp.otp.OTP_RETRIEVED";
    public static final String EXTRA_CODE = "code";

    /** Meta's handshake id, present when the app initiated one. */
    public static final String EXTRA_REQUEST_ID = "request_id";

    /**
     * A code is digits, four to ten of them. Deliberately loose — Meta lets a merchant choose
     * the length, and rejecting a valid code because it is longer than expected would break
     * auto-read for exactly the merchants who configured it.
     */
    private static final Pattern PLAUSIBLE_CODE = Pattern.compile("^[0-9]{4,10}$");

    /** Receives a delivered code. */
    public interface Listener {
        void onCode(String code);
    }

    /**
     * The code, waiting for a listener.
     *
     * <p>Held rather than dropped because the receiver can fire before JS is running.
     * Single-slot: a newer code always replaces an older one, which is what a user requesting a
     * second OTP expects, and it cannot grow without bound.
     */
    private static volatile String pending;
    private static volatile Listener listener;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_OTP_RETRIEVED.equals(intent.getAction())) return;

        String code = intent.getStringExtra(EXTRA_CODE);
        code = code == null ? null : code.trim();
        if (code == null || code.isEmpty()) {
            Log.w(TAG, "WhatsApp OTP broadcast carried no code");
            return;
        }

        // Shape check, not a security boundary — WhatsApp's package + signing-hash match is
        // that. This only stops an obviously wrong payload becoming a code the app tries to
        // verify, which would surface to the user as a failure they cannot explain.
        if (!PLAUSIBLE_CODE.matcher(code).matches()) {
            Log.w(TAG, "WhatsApp OTP broadcast carried an implausible code; ignoring");
            return;
        }

        String requestId = intent.getStringExtra(EXTRA_REQUEST_ID);
        Log.d(TAG, "WhatsApp OTP received (" + code.length() + " chars, requestId="
                + (requestId != null) + ")");
        deliver(code);
    }

    /** Deliver now if something is listening, otherwise hold it. */
    public static synchronized void deliver(String code) {
        Listener target = listener;
        if (target != null) {
            target.onCode(code);
        } else {
            pending = code;
        }
    }

    /**
     * Attach a sink, and hand it anything that arrived while nothing was listening. Taking the
     * pending code rather than copying it means a code is delivered once — a re-listen after a
     * JS reload should not replay a code the user already used.
     */
    public static synchronized void setListener(Listener target) {
        listener = target;
        if (target == null) return;
        String held = pending;
        pending = null;
        if (held != null) target.onCode(held);
    }

    /** Drop anything held. Called when a fresh OTP request starts. */
    public static synchronized void clearPending() {
        pending = null;
    }
}
