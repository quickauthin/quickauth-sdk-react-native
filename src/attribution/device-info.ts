import { Dimensions, PixelRatio, Platform, NativeModules } from 'react-native';
import type { DeviceFingerprint, DeviceInfo } from '../types';
import { getAppIdentity } from '../core/app-identity';
import { SDK_PLATFORM, SDK_VERSION } from '../version';

function detectTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function detectLocale(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings: any = (NativeModules as any).SettingsManager;
    if (Platform.OS === 'ios' && settings?.settings) {
      return (
        settings.settings.AppleLocale ||
        settings.settings.AppleLanguages?.[0] ||
        undefined
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i18n: any = (NativeModules as any).I18nManager;
    if (Platform.OS === 'android' && i18n?.localeIdentifier) {
      return i18n.localeIdentifier;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getFingerprint(extra?: Partial<DeviceFingerprint>): DeviceFingerprint {
  let platform: DeviceFingerprint['platform'] = 'unknown';
  if (Platform.OS === 'ios') platform = 'ios';
  else if (Platform.OS === 'android') platform = 'android';
  else if (Platform.OS === 'web') platform = 'web';

  let width: number | undefined;
  let height: number | undefined;
  let pixelRatio: number | undefined;
  try {
    const { width: w, height: h } = Dimensions.get('window');
    width = w;
    height = h;
    pixelRatio = PixelRatio.get();
  } catch {
    /* noop */
  }

  return {
    platform,
    osVersion: typeof Platform.Version === 'string' || typeof Platform.Version === 'number'
      ? String(Platform.Version)
      : undefined,
    screenWidth: width,
    screenHeight: height,
    pixelRatio,
    timezone: detectTimezone(),
    locale: detectLocale(),
    ...extra,
  };
}

/**
 * `deviceInfo` sent with initiate/verify (with consent) and attribution
 * launches. Same shape as Flutter. Audit metadata only, not used for OneTap.
 */
export function captureDeviceInfo(): DeviceInfo {
  const fp = getFingerprint();
  const app = getAppIdentity();
  const info: DeviceInfo = {
    platform: fp.platform,
    timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
    sdk: `${SDK_PLATFORM}/${SDK_VERSION}`,
  };
  if (fp.osVersion) info.osVersion = fp.osVersion;
  if (fp.locale) info.locale = fp.locale.replace(/_/g, '-');
  if (app.appVersion) info.appVersion = app.appVersion;
  if (app.appBuild) info.appBuild = app.appBuild;
  if (app.appId) info.appId = app.appId;
  return info;
}
