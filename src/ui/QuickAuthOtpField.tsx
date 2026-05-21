import React, { useCallback, useEffect, useRef } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { observeOTP } from '../auth/otp';
import { colors, radius, typography } from './theme';

export interface QuickAuthOtpFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  digitCount?: number;
  /** Subscribe to Android SMS Retriever; iOS relies on textContentType prop. */
  autoFillFromSms?: boolean;
  onCodeFilled?: (code: string) => void;
  style?: StyleProp<ViewStyle>;
  cellStyle?: StyleProp<ViewStyle>;
  cellTextStyle?: StyleProp<TextStyle>;
  autoFocus?: boolean;
  editable?: boolean;
}

export function QuickAuthOtpField(props: QuickAuthOtpFieldProps): React.ReactElement {
  const {
    value,
    onChangeText,
    digitCount = 6,
    autoFillFromSms = true,
    onCodeFilled,
    style,
    cellStyle,
    cellTextStyle,
    autoFocus = true,
    editable = true,
  } = props;

  const inputRef = useRef<TextInput | null>(null);
  const filledRef = useRef(false);

  const handleChange = useCallback(
    (next: string) => {
      const cleaned = next.replace(/\D/g, '').slice(0, digitCount);
      onChangeText(cleaned);
      if (cleaned.length === digitCount && !filledRef.current) {
        filledRef.current = true;
        onCodeFilled?.(cleaned);
      } else if (cleaned.length < digitCount) {
        filledRef.current = false;
      }
    },
    [digitCount, onChangeText, onCodeFilled]
  );

  useEffect(() => {
    if (!autoFillFromSms) return undefined;
    const sub = observeOTP((code) => {
      const cleaned = code.replace(/\D/g, '').slice(0, digitCount);
      if (cleaned.length === digitCount) handleChange(cleaned);
    });
    return () => sub.remove();
  }, [autoFillFromSms, digitCount, handleChange]);

  const cells: React.ReactElement[] = [];
  for (let i = 0; i < digitCount; i += 1) {
    const filled = value.length > i;
    const focused = value.length === i;
    cells.push(
      <View
        key={i}
        style={[
          styles.cell,
          focused && styles.cellFocused,
          filled && styles.cellFilled,
          cellStyle,
        ]}
      >
        <Text style={[styles.digit, cellTextStyle]}>{value[i] ?? ''}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <View style={styles.row}>{cells}</View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        textContentType={Platform.OS === 'ios' ? 'oneTimeCode' : 'none'}
        autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
        importantForAutofill="yes"
        maxLength={digitCount}
        autoFocus={autoFocus}
        editable={editable}
        caretHidden
        selectionColor={colors.accentDeep}
        style={styles.hiddenInput}
        accessibilityLabel="One-time code"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', width: '100%' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  cell: {
    flex: 1,
    aspectRatio: 1,
    marginHorizontal: 4,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFocused: { borderColor: colors.accentDeep, borderWidth: 2 },
  cellFilled: { borderColor: colors.ink, backgroundColor: colors.accentTint },
  digit: {
    fontFamily: typography.fontMono,
    fontSize: 22,
    fontWeight: typography.weightSemibold,
    color: colors.ink,
  },
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.01,
    color: colors.ink,
    fontSize: 22,
    textAlign: 'center',
  },
});

export default QuickAuthOtpField;
