/**
 * QuickAuth design tokens — sourced from quickauth-website tokens.css.
 * Mirrors the brand: accent green #00C637, mono [Q] badge, italic serif wordmark.
 */

export const colors = {
  bg: '#FAFAF7',
  bgCard: '#ffffff',
  bgDark: '#0A0A0A',
  bgMuted: '#F1F0EA',
  ink: '#0A0A0A',
  inkSoft: '#555555',
  inkMute: '#888888',
  inkFaint: '#aaaaaa',
  line: 'rgba(0, 0, 0, 0.08)',
  accent: '#00E640',
  accentDeep: '#00C637',
  accentDarker: '#00772B',
  accentSoft: '#E6F9EC',
  accentTint: '#F4FCEF',
  whatsApp: '#25D366',
  warn: '#b87b00',
  danger: '#b94c4c',
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
} as const;

export const typography = {
  fontSans: 'System',
  fontMono: 'Menlo',
  fontSerif: 'Georgia',
  weightRegular: '400' as const,
  weightMedium: '500' as const,
  weightSemibold: '600' as const,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;
