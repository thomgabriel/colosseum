import { afterEach, describe, expect, it, vi } from 'vitest';
import { gate, inPool, makeReader, notKept, READS_AT_ONCE } from './data';

// The reader of the risk API: an answer is kept for the life of the page, a failure is not, and the
// API is asked three times, a second apart, before the page says it did not answer.

const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('the reader of the risk API', () => {
  it('keeps an answer: the same route is read once', async () => {
    const fetcher = vi.fn(() => answer(200, { ok: 1 }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    await r.get('/risk/assets?tau=0.01');
    const again = await r.get('/risk/assets?tau=0.01');
    expect(again.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a 404 too: the API said it has no such route', async () => {
    const fetcher = vi.fn(() => answer(404, { message: 'Route GET:/risk/x not found' }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect((await r.get('/risk/x')).reason).toBe('not_served');
    await r.get('/risk/x');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure: no answer, or the server’s own error, is asked again', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementationOnce(() => answer(503, { error: 'busy' }))
      .mockImplementation(() => answer(200, { ok: 1 }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect((await r.get('/risk/pools')).reason).toBe('api_error');
    expect((await r.get('/risk/pools')).reason).toBe('api_error');
    expect((await r.get('/risk/pools')).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('asks again when the first probe finds nothing, and says up once one answers', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('slow')))
      .mockImplementation(() => answer(200, { methodVersion: 'risk-0.3' }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect(await r.probe()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('probes the API each time, and tells of an answer the API gave, not of one kept', async () => {
    const fetcher = vi.fn(() => answer(200, { ok: 1 }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect(await r.probe()).toBe(true);
    expect(await r.probe()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const heard = vi.fn();
    const off = r.onAnswer?.(heard);
    await r.get('/risk/pools');
    await r.get('/risk/pools');
    expect(heard).toHaveBeenCalledTimes(1);
    off?.();
    await r.get('/risk/assets');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('the reader on a slow API', () => {
  afterEach(() => vi.useRealTimers());

  it('asks a slow API once: probes asked together share one, and a try that timed out waits for the same request', async () => {
    vi.useFakeTimers();
    // the API answers its methodology after 11 s, as the hosted one did under load
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) =>
          setTimeout(() => done(new Response('{}', { status: 200 })), 11_000),
        ),
    );
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    // the provider probes on arrival and again once the chain is known
    const both = Promise.all([r.probe(), r.probe()]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await both).toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it(`sends ${READS_AT_ONCE} reads at a time, in the order asked, and a route asked twice once`, async () => {
    const open: string[] = [];
    let most = 0;
    const fetcher = vi.fn(async (url: string) => {
      open.push(url);
      most = Math.max(most, open.length);
      await new Promise((d) => setTimeout(d, 2));
      open.splice(open.indexOf(url), 1);
      return new Response('{}', { status: 200 });
    });
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    const paths = Array.from({ length: 8 }, (_, i) => `/risk/thing?${i}`);
    await Promise.all([...paths, ...paths].map((p) => r.get(p)));
    expect(most).toBe(READS_AT_ONCE);
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual(paths.map((p) => `http://api${p}`));
  });

  it('a probe is not held behind the reads: it says whether the API is there while they wait', async () => {
    const fetcher = vi.fn((url: string) =>
      url.endsWith('/risk/facts/methodology')
        ? Promise.resolve(new Response('{}', { status: 200 }))
        : new Promise<Response>(() => {}),
    );
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    for (let i = 0; i < READS_AT_ONCE + 2; i++) void r.get(`/risk/hung?${i}`);
    expect(await r.probe()).toBe(true);
  });
});

describe('reads a few at a time', () => {
  it('a queue told to stop starts no further item, and lets the ones it started finish', async () => {
    const started: number[] = [];
    let left = false;
    const out = await inPool(
      [1, 2, 3, 4, 5, 6],
      2,
      async (i) => {
        started.push(i);
        // the second item is the last anyone waits for
        if (i === 2) left = true;
        await Promise.resolve();
        return i;
      },
      () => left,
    );
    expect(started).toEqual([1, 2]);
    expect(out).toEqual([1, 2]);
    // told nothing, it runs them all, as it always did
    expect(await inPool([1, 2, 3], 2, async (i) => i * 2)).toEqual([2, 4, 6]);
  });

  it('a gate lets its width through at a time, whichever queue asks, and a failed task gives its place back', async () => {
    const turn = gate(2);
    const seen = { open: 0, most: 0 };
    const read = (i: number) =>
      turn(async () => {
        seen.most = Math.max(seen.most, ++seen.open);
        await new Promise((r) => setTimeout(r, 1));
        seen.open--;
        return i;
      });
    // two queues of two at a time through one gate: two at a time in all
    const [a, b] = await Promise.all([inPool([1, 2, 3], 2, read), inPool([4, 5, 6], 2, read)]);
    expect(seen.most).toBe(2);
    expect([...a, ...b].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(turn(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    await expect(Promise.all([read(7), read(8), read(9)])).resolves.toEqual([7, 8, 9]);
    expect(seen.most).toBe(2);
  });

  it('says which failures the reader does not keep: no answer, or the server’s own error', () => {
    const failure = (status: number) => ({
      ok: false as const,
      status,
      body: null,
      reason: 'api_error',
    });
    expect([0, 500, 503].map((status) => notKept(failure(status)))).toEqual([true, true, true]);
    expect(notKept(failure(404))).toBe(false);
    expect(notKept({ ok: true, status: 200, body: {}, reason: null })).toBe(false);
  });
});
