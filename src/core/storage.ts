/**
 * Storage abstraction — duck-types @react-native-async-storage/async-storage
 * if installed; falls back to in-memory storage. Customer apps that opt out of
 * AsyncStorage simply lose persistence across app launches.
 */

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let backend: AsyncStorageLike | null = null;
let resolved = false;

function resolveBackend(): AsyncStorageLike | null {
  if (resolved) return backend;
  resolved = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-async-storage/async-storage');
    const candidate = mod?.default ?? mod;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      backend = candidate as AsyncStorageLike;
    }
  } catch {
    backend = null;
  }
  return backend;
}

const memory = new Map<string, string>();

export async function getItem(key: string): Promise<string | null> {
  const b = resolveBackend();
  if (b) return b.getItem(key);
  return memory.has(key) ? memory.get(key)! : null;
}

export async function setItem(key: string, value: string): Promise<void> {
  const b = resolveBackend();
  if (b) return b.setItem(key, value);
  memory.set(key, value);
}

export async function removeItem(key: string): Promise<void> {
  const b = resolveBackend();
  if (b) return b.removeItem(key);
  memory.delete(key);
}

/** Test-only. */
export function __resetStorage(): void {
  memory.clear();
  backend = null;
  resolved = false;
}
