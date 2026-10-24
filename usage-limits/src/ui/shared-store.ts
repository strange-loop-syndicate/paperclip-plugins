// A cache entry shared by every tab of a browser: kept in localStorage, read
// by all tabs, and written by whichever tab holds the Web Lock. Tabs learn of
// each other's writes through the `storage` event.

export interface SharedStore<T> {
  /** Current value; the same object until the stored value changes. */
  getSnapshot(): T | null;
  write(value: T): void;
  isBusy(): boolean;
  setBusy(value: boolean): void;
  /** Subscribe to changes from this tab and, through the `storage` event, from others. */
  subscribe(fn: () => void): () => void;
  /** Run `fn` only if no other tab holds the lock; null when it does. */
  withLock<R>(fn: () => Promise<R>): Promise<R | null>;
}

export function createSharedStore<T>(key: string, lockName: string, parse: (raw: string | null) => T | null): SharedStore<T> {
  let memoryRaw: string | null = null;
  let snapshotRaw: string | null | undefined;
  let snapshot: T | null = null;
  let busy = false;
  const listeners = new Set<() => void>();

  const readRaw = (): string | null => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memoryRaw;
    }
  };
  const notify = () => {
    for (const fn of listeners) fn();
  };

  return {
    getSnapshot() {
      const raw = readRaw();
      if (raw !== snapshotRaw) {
        snapshotRaw = raw;
        snapshot = parse(raw);
      }
      return snapshot;
    },
    write(value) {
      const raw = JSON.stringify(value);
      memoryRaw = raw;
      try {
        window.localStorage.setItem(key, raw);
      } catch {
        // storage full or blocked: this tab keeps the in-memory copy
      }
      notify();
    },
    isBusy: () => busy,
    setBusy(value) {
      busy = value;
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key || e.key === null) fn();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(fn);
        window.removeEventListener("storage", onStorage);
      };
    },
    async withLock(fn) {
      if (busy) return null;
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      if (!locks) return fn();
      return locks.request(lockName, { ifAvailable: true }, (lock) => (lock ? fn() : null));
    },
  };
}
