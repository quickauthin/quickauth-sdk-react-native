import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { startOTP, verifyOTP } from '../auth/otp';
import { OtpChannel } from '../types';
import { colors, radius, spacing, typography } from './theme';

export interface QuickAuthLoginButtonProps {
  phone: string;
  channel?: OtpChannel;
  text?: string;
  /**
   * Optional pre-filled OTP code; when provided, the button skips startOTP and
   * jumps straight to verifyOTP(). Most apps will let the SDK handle the full
   * flow internally with their own custom <QuickAuthOtpField/>.
   */
  code?: string;
  /** Pre-existing session ID from a prior startOTP() call. */
  sessionId?: string;
  onSessionStarted?: (sessionId: string) => void;
  /**
   * Called when verification succeeds. Receives the QuickAuth `requestId` —
   * forward it to your backend, which confirms server-to-server via
   * `GET /v1/auth/status?requestId=...` and mints its own session JWT.
   * See https://quickauth.in/docs/backend
   */
  onSuccess?: (requestId: string) => void;
  onError?: (error: Error) => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  disabled?: boolean;
}

/**
 * Default action: tapping the button calls startOTP() and emits onSessionStarted.
 * If you also provide `code` (e.g., user filled the OTP field), the second tap
 * verifies and emits onSuccess.
 */
export function QuickAuthLoginButton(props: QuickAuthLoginButtonProps): React.ReactElement {
  const {
    phone,
    channel = OtpChannel.AUTO,
    text = 'Continue',
    code,
    sessionId,
    onSessionStarted,
    onSuccess,
    onError,
    style,
    textStyle,
    disabled,
  } = props;

  const [loading, setLoading] = useState(false);

  const handlePress = useCallback(async () => {
    if (loading || disabled) return;
    setLoading(true);
    try {
      if (code && sessionId) {
        const result = await verifyOTP({ sessionId, code });
        if (!result.verified) throw new Error(result.message || 'Verification failed');
        onSuccess?.(result.requestId);
      } else {
        const session = await startOTP({ phone, channel });
        onSessionStarted?.(session.sessionId);
      }
    } catch (e) {
      onError?.(e as Error);
    } finally {
      setLoading(false);
    }
  }, [loading, disabled, code, sessionId, phone, channel, onSessionStarted, onSuccess, onError]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        (disabled || loading) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      <View style={styles.inner}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Q</Text>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <Text style={[styles.label, textStyle]}>{text}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.85 },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.accent,
    fontFamily: typography.fontMono,
    fontSize: 13,
    fontWeight: typography.weightSemibold,
  },
  label: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: typography.weightMedium,
    fontFamily: typography.fontSans,
  },
});

export default QuickAuthLoginButton;
