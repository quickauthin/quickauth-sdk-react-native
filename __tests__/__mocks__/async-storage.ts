// Mock for the AsyncStorage peer dep, mapped via jest moduleNameMapper.
// storage.__resetStorage() calls __quickauthTestClear between tests.

const store = new Map<string, string>();

const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> =>
    store.has(key) ? store.get(key)! : null,
  setItem: async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
  clear: async (): Promise<void> => {
    store.clear();
  },
  __quickauthTestClear: (): void => {
    store.clear();
  },
};

export default AsyncStorage;
