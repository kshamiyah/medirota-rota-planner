/** In-memory localStorage and window.storage for Node vitest runs. Must be imported first. */
const memory = new Map<string, string>();

const localStorageMock = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() { return memory.size; },
};

type Listener = (event: { key: string | null }) => void;
const storageListeners = new Set<Listener>();

class FakeStorageEvent {
  key: string | null;
  constructor(_type: string, init?: { key?: string | null }) { this.key = init?.key ?? null; }
}

const windowMock = {
  addEventListener: (type: string, listener: Listener) => { if (type === 'storage') storageListeners.add(listener); },
  removeEventListener: (type: string, listener: Listener) => { if (type === 'storage') storageListeners.delete(listener); },
  dispatchEvent: (event: { key: string | null }) => { for (const listener of storageListeners) listener(event); return true; },
};

Object.assign(globalThis, { localStorage: localStorageMock, window: windowMock, StorageEvent: FakeStorageEvent });

export function clearPolyfillStorage(): void {
  memory.clear();
}
