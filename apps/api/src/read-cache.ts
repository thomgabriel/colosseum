// The reads the conversations make of Bearing's data, kept and bounded: a cache by key, a limit on reads
// at once and a time limit on each. Shared by the analytics the conversations are handed
// (agent-analytics.ts) and the lookups they may make of one asset (asset-lookups.ts).

/** Entries the cache holds before it drops what has not been asked for in two lifetimes. */
const MAX_KEPT = 2_000;

/** `work`, or a rejection once `ms` have passed without its answer. */
export function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), ms);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** At most `n` reads at once; the rest wait their turn, and a finished read hands its turn on. */
export function limiter(n: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * A read kept by key: a fresh one is served as it is, an older one is served while it is read again, and
 * a missing one is read once however many turns ask. A failed read keeps what was there.
 */
export function keeper<T>(ttl: number, now: () => number, maxKept = MAX_KEPT) {
  const kept = new Map<string, { at: number; value?: { v: T }; read?: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    if (kept.size > maxKept)
      for (const [k, e] of kept) if (!e.read && now() - e.at > 2 * ttl) kept.delete(k);
    const entry = kept.get(key) ?? { at: 0 };
    kept.set(key, entry);
    if (!entry.read && (!entry.value || now() - entry.at > ttl)) {
      const read = load();
      entry.read = read;
      read.then(
        (v) => {
          entry.value = { v };
          entry.at = now();
          entry.read = undefined;
        },
        () => {
          entry.read = undefined;
          if (!entry.value) kept.delete(key);
        },
      );
    }
    return entry.value ? Promise.resolve(entry.value.v) : (entry.read as Promise<T>);
  };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The collectors store an EVM address in lower case; a shelf may spell it checksummed. */
export const stored = (address: string) =>
  EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
