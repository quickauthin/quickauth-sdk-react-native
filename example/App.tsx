import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import QuickAuth, {
  QuickAuthLoginButton,
  QuickAuthOtpField,
  OtpChannel,
  colors,
} from '@quickauth/react-native';

export default function App(): React.ReactElement {
  const [phone, setPhone] = useState('+919876543210');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [jwt, setJwt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      await QuickAuth.init({ publishableKey: 'pk_test_REPLACE_ME' });
      QuickAuth.consent.set(true); // assume in-app consent dialog has run
      const attribution = await QuickAuth.attribution.captureLaunch();
      // eslint-disable-next-line no-console
      console.log('[QuickAuth] launch attribution', attribution);
    })();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Q</Text>
          </View>
          <Text style={styles.wordmark}>QuickAuth</Text>
        </View>

        <Text style={styles.label}>Phone</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          style={styles.input}
          keyboardType="phone-pad"
          placeholder="+91…"
        />

        {!sessionId ? (
          <QuickAuthLoginButton
            phone={phone}
            channel={OtpChannel.AUTO}
            text="Send OTP"
            onInitiated={() => setError(null)}
            onError={(e) => setError(e.message)}
            style={{ marginTop: 16 }}
          />
        ) : (
          <>
            <Text style={[styles.label, { marginTop: 24 }]}>Code</Text>
            <QuickAuthOtpField
              value={code}
              onChangeText={setCode}
              digitCount={6}
              autoFillFromSms
              onCodeFilled={async (filled) => {
                try {
                  await QuickAuth.auth.submitOtp(filled);
                  // Outcome arrives via Config.onAuthEvent — when VERIFIED
                  // fires, route to the post-login screen there.
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </>
        )}

        {jwt && (
          <View style={styles.success}>
            <Text style={styles.successText}>Logged in</Text>
            <Text style={styles.jwt} numberOfLines={1}>
              {jwt}
            </Text>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 24,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.accent,
    fontFamily: 'Menlo',
    fontWeight: '600',
    fontSize: 15,
  },
  wordmark: {
    fontSize: 24,
    fontFamily: 'Georgia',
    fontStyle: 'italic',
    color: colors.ink,
  },
  label: {
    fontSize: 12,
    fontFamily: 'Menlo',
    color: colors.inkSoft,
    letterSpacing: 1.4,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.bgCard,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink,
  },
  success: { marginTop: 24, padding: 14, backgroundColor: colors.accentTint, borderRadius: 8 },
  successText: { fontWeight: '600', color: colors.ink },
  jwt: { fontFamily: 'Menlo', fontSize: 11, color: colors.inkSoft, marginTop: 4 },
  error: { marginTop: 16, color: colors.danger, fontSize: 14 },
});
