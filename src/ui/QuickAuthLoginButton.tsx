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
import { initiate, submitOtp } from '../auth/otp';
import { OtpChannel } from '../types';
import { colors, radius, spacing, typography } from './theme';

export interface QuickAuthLoginButtonProps {
  phone: string;
  channel?: OtpChannel;
  text?: string;
  /**
   * If set, the button calls `submitOtp(code)` instead of `initiate()`.
   * Outcomes arrive via `Config.onAuthEvent`.
   */
  code?: string;
  /** Called once `initiate()` is dispatched. Outcome arrives via `Config.onAuthEvent`. */
  onInitiated?: () => void;
  onError?: (error: Error) => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  disabled?: boolean;
}

/**
 * Calls `initiate()` on press, or `submitOtp(code)` when `code` is set.
 * Drive UI from `Config.onAuthEvent`.
 */
export function QuickAuthLoginButton(props: QuickAuthLoginButtonProps): React.ReactElement {
  const {
    phone,
    channel = OtpChannel.AUTO,
    text = 'Continue',
    code,
    onInitiated,
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
      if (code) {
        await submitOtp(code);
      } else {
        await initiate({ phone, channel });
        onInitiated?.();
      }
    } catch (e) {
      onError?.(e as Error);
    } finally {
      setLoading(false);
    }
  }, [loading, disabled, code, phone, channel, onInitiated, onError]);

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
