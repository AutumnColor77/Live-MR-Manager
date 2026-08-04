/**
 * Minimal browser globals for Node-based Vitest runs.
 * Avoids pulling jsdom just for localStorage / window checks.
 */
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
}

if (typeof globalThis.performance === "undefined") {
  globalThis.performance = { now: () => Date.now() };
}
