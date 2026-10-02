package io.quickauth.rnsdk;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Same cases as the Flutter SDK's sms_retriever_test.dart. */
public class ExtractCodeTest {
    private static String extract(String body) {
        return QuickAuthSmsRetrieverModule.extractCode(body);
    }

    @Test public void takesTheCodeAfterTheKeywordNotTheOrderNumberBeforeIt() {
        assertEquals("483920", extract("Your OTP for order 4471029 is 483920"));
    }

    @Test public void plainYourOtpIs() {
        assertEquals("483920", extract("Your OTP is 483920. Do not share it."));
    }

    @Test public void colonSeparator() {
        assertEquals("4821", extract("code: 4821"));
    }

    @Test public void dashSeparator() {
        assertEquals("123456", extract("Verification code - 123456"));
    }

    @Test public void isCaseInsensitive() {
        assertEquals("998877", extract("YOUR OTP IS 998877"));
    }

    @Test public void matchesPinAndPassword() {
        assertEquals("4321", extract("Your PIN is 4321"));
        assertEquals("87654321", extract("Password: 87654321"));
    }

    @Test public void takesTheLastKeywordMatchWhenABodyCarriesTwo() {
        assertEquals("222222", extract("Old code 111111 expired. Your new code is 222222"));
    }

    @Test public void takesTheLastStandaloneRunNotTheFirst() {
        assertEquals("4455", extract("Ref 8899001 — 4455"));
    }

    @Test public void aBareCodeStillWorks() {
        assertEquals("483920", extract("483920"));
    }

    @Test public void aTenDigitMobileNumberIsSkippedNotTruncated() {
        assertEquals("483920", extract("Sent to 9876543210. Your OTP is 483920"));
    }

    @Test public void aBareTenDigitNumberYieldsNothing() {
        assertEquals("", extract("Call 9876543210 for help"));
    }

    @Test public void theAppHashIsStrippedBeforeScanning() {
        assertEquals("483920", extract("Your OTP is 483920\nFA+9qCX9VSu"));
    }

    @Test public void appHashDoesNotWinTheFallbackPathEither() {
        assertEquals("4455", extract("Ref 8899001 4455 FA+123456/8"));
    }

    @Test public void aMessageWithNoDigitsReturnsEmpty() {
        assertEquals("", extract("Welcome to QuickAuth"));
    }

    @Test public void anEmptyBodyReturnsEmpty() {
        assertEquals("", extract(""));
        assertEquals("", extract(null));
    }

    /** Real template; hash has no leading whitespace. */
    @Test public void realSparkyTemplate() {
        assertEquals("298773", extract(
                "<#> 298773 is your Sparky sign-in OTP. This OTP is valid for 5 minutes.byTs3AvV8hp"));
    }
}
