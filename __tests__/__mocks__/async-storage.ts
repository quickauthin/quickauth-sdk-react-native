/**
 * Stands in for `@react-native-async-storage/async-storage`, which is a peer
 * dependency of the SDK and therefore present in any real app but not
 * installed in this repo (it carries native code and nothing here runs it).
 *
 * Mapped in package.json's jest `moduleNameMapper`, so the SDK's storage layer
 * resolves it exactly as it would on a device.
 *
 * `__quickauthTestClear` is the hook `storage.__resetStorage()` looks for: a
 * real AsyncStorage does not have it and is never emptied by the SDK, while
 * this one is emptied between tests so a key written by one test is not still
 * there in the next.
 */

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
