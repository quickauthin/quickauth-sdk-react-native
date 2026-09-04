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
 * Receives a WhatsApp zero-tap or one-tap authentication code.
 *
 * <p>WhatsApp does not deliver these over SMS. It broadcasts to the app named in the template's
 * {@code supported_apps}, matched on package name and the 11-character signing hash, so Google's
 * SMS Retriever never sees the message. Before this receiver existed the code was dropped on the
 * floor: a merchant sending on the {@code whatsapp} channel got no auto-read at all, and one
 * sending on {@code auto} got it for the users the backend happened to route over SMS and not for
 * the rest, with nothing to explain the difference.
 *
 * <p>Declared in the SDK's {@code AndroidManifest.xml} rather than registered at runtime.
 * Zero-tap's promise is that the user does nothing, which means the code can arrive while the app
 * is backgrounded or not running at all — a runtime receiver only exists once the app already
 * does, which is the case that needs it least. Being a library manifest entry it merges into every
 * host app automatically; merchants declare nothing.
 *
 * <p>The receiver is exported with no permission guard, matching Meta's documented declaration.
 * Guarding it would be worse than useless: Android silently drops a broadcast aimed at a receiver
 * whose permission the sender does not hold, so a guessed permission name produces a receiver that
 * never fires, with nothing thrown and nothing logged. Safety comes from WhatsApp's side — it only
 * broadcasts to an app whose package name and signing hash match the approved template, which an
 * attacker cannot satisfy without the signing key. What is left to us is not trusting the payload
 * blindly: a code that is not plausibly a code is dropped.
 *
 * <p>Because the broadcast can start the process, the code can arrive with no JavaScript running.
 * It is held here and flushed the moment the bridge subscribes, so a cold start does not lose it.
 */
public class WhatsAppOtpReceiver extends BroadcastReceiver {

    private static final String TAG = "QuickAuthWaOtp";

    /**
     * WhatsApp's broadcast contract. Both zero-tap and one-tap arrive this way — one-tap is the
     * same delivery with a user tap in front of it — so one receiver serves both.
     *
     * <p>A wrong value here fails in the worst way available: the broadcast is simply never
     * matched, nothing throws, and the OTP silently does not arrive. The action is duplicated in
     * {@code AndroidManifest.xml}, which cannot reference a Java constant; the two must change
     * together.
     */
    public static final String ACTION_OTP_RETRIEVED = "com.whatsapp.otp.OTP_RETRIEVED";

    /** The code itself — already extracted by WhatsApp, unlike the SMS path. */
    public static final String EXTRA_CODE = "code";

    /** Meta's handshake id, present when the app initiated one. */
    public static final String EXTRA_REQUEST_ID = "request_id";

    /**
     * A code is digits, four to ten of them. Deliberately looser than the SDK's own 4–8 verify-side
     * rule: Meta lets a merchant choose the length, and rejecting a valid code here because it is
     * longer than expected would break auto-read for exactly the merchants who configured it.
     */
    private static final Pattern PLAUSIBLE_CODE = Pattern.compile("^[0-9]{4,10}$");

    /** Notified when a code arrives. */
    public interface Listener {
        void onCode(String code);
    }

    private static final Object LOCK = new Object();

    /**
     * The code, waiting for a listener.
     *
     * <p>Held rather than dropped because the receiver can fire before the React context exists —
     * that is the entire point of zero-tap. Single-slot: a newer code always replaces an older one,
     * which is what a user requesting a second OTP expects, and it cannot grow without bound.
     */
    private static String pending = null;

    /**
     * Every live subscriber. A list rather than a single slot because two subscriptions are the
     * normal case, not an edge one: the OTP service arms auto-read on the caller's behalf and a
     * merchant's OTP field may call observeOTP at the same time. With a single slot the second
     * would silently evict the first, and the first's teardown would then null out the second.
     */
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

        // Shape check, not a security boundary — WhatsApp's package + signing-hash match is that.
        // This only stops an obviously wrong payload becoming a code the app tries to verify,
        // which would surface to the user as a failure they cannot explain.
        if (!PLAUSIBLE_CODE.matcher(code).matches()) {
            Log.w(TAG, "WhatsApp OTP broadcast carried an implausible code; ignoring");
            return;
        }

        Log.d(TAG, "WhatsApp OTP received (" + code.length() + " chars)");
        deliver(code);
    }

    /** Deliver now to everything listening, otherwise hold it. */
    public static void deliver(String code) {
        List<Listener> targets;
        synchronized (LOCK) {
            if (listeners.isEmpty()) {
                pending = code;
                return;
            }
            targets = new ArrayList<>(listeners);
        }
        // A throwing subscriber must not stop the others from being told.
        for (Listener target : targets) {
            try {
                target.onCode(code);
            } catch (Throwable t) {
                Log.w(TAG, "WhatsApp OTP listener threw", t);
            }
        }
    }

    /**
     * Attach a subscriber, and hand it anything that arrived while nothing was listening.
     *
     * <p>Taking the pending code rather than copying it means a code is delivered once — a
     * re-subscribe after a screen remount should not replay a code the user already spent.
     */
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

    /**
     * Drop anything held. Called when a fresh OTP request starts, because a code that arrived after
     * the user gave up on a previous attempt would otherwise be delivered against the new request
     * and fail verification for reasons they cannot see.
     */
    public static void clearPending() {
        synchronized (LOCK) {
            pending = null;
        }
    }
}
