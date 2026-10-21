import { describe, expect, it } from 'vitest';
import { keeper } from './read-cache';

// A kept read is served fresh up to its lifetime, served once more while it is read again up to twice
// that, and read through after: a server idle for hours does not answer its first turn with old figures.

describe('keeper', () => {
  const TTL = 60;
  function setup() {
    let clock = 0;
    let n = 0;
    let fail = false;
    const keep = keeper<number>(TTL, () => clock);
    const load = async () => {
      if (fail) throw new Error('no answer');
      return ++n;
    };
    return {
      ask: () => keep('k', load),
      at: (t: number) => {
        clock = t;
      },
      failing: () => {
        fail = true;
      },
      reads: () => n,
    };
  }

  it('serves a fresh read, then a stale one while it is read again', async () => {
    const k = setup();
    expect(await k.ask()).toBe(1);
    k.at(TTL);
    expect(await k.ask()).toBe(1);
    expect(k.reads()).toBe(1);
    k.at(TTL + 1);
    // the kept value answers at once; the new read fills the cache behind it
    expect(await k.ask()).toBe(1);
    expect(k.reads()).toBe(2);
    expect(await k.ask()).toBe(2);
  });

  it('reads through a value older than twice its lifetime instead of serving it', async () => {
    const k = setup();
    expect(await k.ask()).toBe(1);
    k.at(2 * TTL);
    expect(await k.ask()).toBe(1);
    // the read that started at 2 × TTL fills the cache; a long idle follows
    expect(await k.ask()).toBe(2);
    k.at(2 * TTL + 2 * TTL + 1);
    expect(await k.ask()).toBe(3);
    expect(k.reads()).toBe(3);
  });

  it('does not fall back on a value that old when reading it again fails', async () => {
    const k = setup();
    expect(await k.ask()).toBe(1);
    k.at(2 * TTL + 1);
    k.failing();
    await expect(k.ask()).rejects.toThrow('no answer');
  });
});
