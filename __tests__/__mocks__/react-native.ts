/**
 * Minimal react-native mock for unit tests. Pure TS — no React Native runtime
 * needed. Tests can override fields by re-importing and mutating.
 */

type Listener = (...args: unknown[]) => void;

class MockEmitter {
  private listeners = new Map<string, Set<Listener>>();
  addListener(event: string, cb: Listener): { remove: () => void } {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return {
      remove: () => {
        this.listeners.get(event)?.delete(cb);
      },
    };
  }
  emit(event: string, payload?: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }
  removeAllListeners(): void {
    this.listeners.clear();
  }
}

export const Platform = {
  OS: 'android' as 'ios' | 'android' | 'web' | 'unknown',
  Version: 33 as string | number,
  select: <T,>(spec: { ios?: T; android?: T; default?: T }): T | undefined =>
    (spec as Record<string, T>)[(Platform as { OS: string }).OS] ?? spec.default,
};

const smsEmitter = new MockEmitter();

export const NativeModules: Record<string, unknown> = {
  QuickAuthSmsRetriever: {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getAppHash: jest.fn().mockResolvedValue('TEST12HASH'),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    __emit: (payload: unknown) => smsEmitter.emit('qa.sms.code', payload),
  },
  SettingsManager: { settings: { AppleLocale: 'en_US', AppleLanguages: ['en'] } },
  I18nManager: { localeIdentifier: 'en_US' },
};

export class NativeEventEmitter {
  // Match real RN: NativeEventEmitter accepts the native module as the source.
  constructor(_module?: unknown) {
    /* noop — we route everything through the shared smsEmitter for tests */
  }
  addListener(event: string, cb: Listener) {
    return smsEmitter.addListener(event, cb);
  }
  removeAllListeners() {
    smsEmitter.removeAllListeners();
  }
}

interface MockLinking {
  _initialUrl: string | null;
  _listeners: Set<(e: { url: string }) => void>;
  getInitialURL: jest.Mock<Promise<string | null>>;
  canOpenURL: jest.Mock<Promise<boolean>, [string]>;
  openURL: jest.Mock<Promise<void>, [string]>;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  __emitUrl: (url: string) => void;
}

export const Linking: MockLinking = {
  _initialUrl: null,
  _listeners: new Set<(e: { url: string }) => void>(),
  getInitialURL: jest.fn<Promise<string | null>, []>(async () => Linking._initialUrl),
  canOpenURL: jest.fn<Promise<boolean>, [string]>(async () => true),
  openURL: jest.fn<Promise<void>, [string]>(async () => undefined),
  addEventListener: jest.fn((event: string, cb: (e: { url: string }) => void) => {
    if (event === 'url') Linking._listeners.add(cb);
    return { remove: () => Linking._listeners.delete(cb) };
  }),
  removeEventListener: jest.fn(),
  __emitUrl: (url: string) => {
    Linking._listeners.forEach((cb) => cb({ url }));
  },
};

export const Dimensions = {
  get: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 })),
};

export const PixelRatio = {
  get: jest.fn(() => 3),
};

// Stubs for React component imports in tests we don't render.
export const Pressable = 'Pressable';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const View = 'View';
export const ActivityIndicator = 'ActivityIndicator';
export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
};

// Helper for tests
export const __testHelpers = {
  smsEmitter,
  setPlatform: (os: 'ios' | 'android' | 'web') => {
    Platform.OS = os;
  },
  setInitialUrl: (url: string | null) => {
    (Linking as unknown as { _initialUrl: string | null })._initialUrl = url;
  },
};
