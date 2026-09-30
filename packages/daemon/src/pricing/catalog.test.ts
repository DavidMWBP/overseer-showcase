import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PriceCatalog, estimateCost, parsePrices, selectContextPrice, type ModelPrice } from './catalog';

/** The fixture stands in for the real catalog: these tests never reach the network. */
const FIXTURE = fileURLToPath(new URL('./fixtures/models.dev.json', import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-price-'));
}

function fakeFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;
}

function offlineFetch(): typeof fetch {
  return (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
}

describe('PriceCatalog', () => {
  it('resolves a provider-prefixed opencode id, a codex openai id and a claude anthropic id, exactly', () => {
    const catalog = new PriceCatalog(FIXTURE);
    expect(catalog.load()).toBe(true);
    expect(catalog.priceFor('opencode', 'deepseek/deepseek-flash')).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
    // The entry also carries its context bands, which `selectContextPrice` reads per response.
    expect(catalog.priceFor('codex', 'gpt-5.6-terra')).toEqual({
      input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5,
      tiers: [{ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5, size: 272_000 }],
      contextOver200k: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
    });
    expect(catalog.priceFor('claude', 'claude-sonnet-4-6')).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it('records an unknown model as no price rather than guessing a close match', () => {
    const catalog = new PriceCatalog(FIXTURE);
    catalog.load();
    expect(catalog.priceFor('claude', 'fable')).toBeNull(); // a CLI alias the catalog does not carry
    expect(catalog.priceFor('codex', 'gpt-5.6-terra-')).toBeNull();
    expect(catalog.priceFor('opencode', 'deepseek/deepseek-flash-preview')).toBeNull();
    expect(catalog.priceFor('opencode', 'unknown/deepseek-flash')).toBeNull();
  });

  it('serves a bare opencode id only from a single provider; the same id under two is ambiguous', () => {
    const catalog = new PriceCatalog(FIXTURE);
    catalog.load();
    // `claude-sonnet-4-6` is carried by both anthropic and opencode, so a bare id is not guessed.
    expect(catalog.priceFor('opencode', 'claude-sonnet-4-6')).toBeNull();
  });

  it('parses only entries with numeric input and output prices', () => {
    const prices = parsePrices({ p: { models: { a: { cost: { input: 1, output: 2 } }, b: { cost: { input: 1 } }, c: {} } } });
    expect([...prices.entries()]).toEqual([['p\u0000a', { input: 1, output: 2 }]]);
  });

  it('parses context bands alongside the base prices', () => {
    const prices = parsePrices({
      p: { models: {
        a: {
          cost: {
            input: 2, output: 12, cache_read: 0.2, cache_write: 2.5,
            tiers: [{ input: 4, output: 18, cache_read: 0.4, cache_write: 5, tier: { type: 'context', size: 272_000 } }],
            context_over_200k: { input: 4, output: 18, cache_read: 0.4, cache_write: 5 },
          },
        },
        b: { cost: { input: 1, output: 2, tiers: [{ input: 9, output: 9, tier: { type: 'time', size: 5 } }, { input: 8, output: 8, tier: { type: 'context' } }] } },
      } },
    });
    expect(prices.get('p\u0000a')).toEqual({
      input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5,
      tiers: [{ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5, size: 272_000 }],
      contextOver200k: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
    });
    // A `tiers` entry without `type: 'context'` or without a numeric `size` is dropped.
    expect(prices.get('p\u0000b')).toEqual({ input: 1, output: 2 });
  });
});

describe('selectContextPrice', () => {
  const banded: ModelPrice = {
    input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5,
    tiers: [{ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5, size: 272_000 }],
    contextOver200k: { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
  };

  it('selects the largest matching context tier, strictly above its size', () => {
    expect(selectContextPrice(banded, 272_000)).toEqual({ input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }); // no tiers hit -> context_over_200k
    expect(selectContextPrice(banded, 272_001)).toEqual({ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }); // the tiers entry wins
    expect(selectContextPrice(banded, 100)).toEqual(banded); // below 200k -> base
  });

  it('picks the largest size when several tiers match, and falls back to context_over_200k only without a tiers hit', () => {
    const many: ModelPrice = { input: 1, output: 1, tiers: [{ input: 2, output: 2, size: 100_000 }, { input: 3, output: 3, size: 200_000 }], contextOver200k: { input: 9, output: 9 } };
    expect(selectContextPrice(many, 150_000)).toEqual({ input: 2, output: 2 });
    expect(selectContextPrice(many, 250_000)).toEqual({ input: 3, output: 3 });
    const noTiers: ModelPrice = { input: 1, output: 1, contextOver200k: { input: 9, output: 9 } };
    expect(selectContextPrice(noTiers, 200_000)).toEqual(noTiers); // strict >
    expect(selectContextPrice(noTiers, 200_001)).toEqual({ input: 9, output: 9 });
  });
});

describe('estimateCost', () => {
  const price: ModelPrice = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };

  it('prices input, output and cache tokens per million', () => {
    expect(estimateCost(price, { input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 400 })).toBeCloseTo((1000 * 2 + 2000 * 12 + 5000 * 0.2 + 400 * 2.5) / 1_000_000, 12);
  });

  it('treats missing cache prices as zero and returns null when no counters were reported', () => {
    expect(estimateCost({ input: 1, output: 1 }, { input: 1000, output: 1000 })).toBeCloseTo(0.002, 12);
    expect(estimateCost(price, {})).toBeNull();
  });

  it('bills reasoning at the output price only when the harness reports it outside output (opencode)', () => {
    // opencode's own cost function bills the reasoning slice at the output rate and ignores the catalog's `cost.reasoning`.
    const price: ModelPrice = { input: 0.15, output: 0.9, cacheRead: 0.003 };
    const tokens = { input: 9052, output: 73, reasoning: 1000, cacheRead: 1792 };
    expect(estimateCost(price, tokens)).toBeCloseTo((9052 * 0.15 + 73 * 0.9 + 1792 * 0.003) / 1_000_000, 12);
    expect(estimateCost(price, tokens, { billReasoning: true })).toBeCloseTo((9052 * 0.15 + (73 + 1000) * 0.9 + 1792 * 0.003) / 1_000_000, 12);
  });

  it('bills only the non-cached input when the harness counts cache tokens inside input (Codex)', () => {
    const tokens = { input: 100_000, output: 2000, cacheRead: 90_000, cacheWrite: 500 };
    // Codex: 100k input of which 90k cached and 500 cache-write → 9.5k billed at the input rate.
    expect(estimateCost(price, tokens, { inputIncludesCacheTokens: true })).toBeCloseTo((9_500 * 2 + 2000 * 12 + 90_000 * 0.2 + 500 * 2.5) / 1_000_000, 12);
    // Claude and opencode report input without cache tokens, so the whole input is billed and the cache counters are added.
    expect(estimateCost(price, tokens)).toBeCloseTo((100_000 * 2 + 2000 * 12 + 90_000 * 0.2 + 500 * 2.5) / 1_000_000, 12);
  });

  it('never bills a negative input slice when a cache counter exceeds the reported input', () => {
    expect(estimateCost(price, { input: 1000, cacheRead: 5000 }, { inputIncludesCacheTokens: true })).toBeCloseTo(5000 * 0.2 / 1_000_000, 12);
  });

  describe('cacheWrite1h (Claude 1-hour cache TTL)', () => {
    const fable: ModelPrice = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

    it('bills the 1h slice at 2x the input rate and the rest of cacheWrite at the 5m rate', () => {
      // The real numbers from fixtures/claude.jsonl's result line (input 34, cache_creation 43514 all ephemeral_1h,
      // cache_read 43017, output 231) price claude-fable-5-1 at 0.89292425, within 0.1% of the CLI's own 0.89389225.
      const tokens = { input: 34, output: 231, cacheRead: 43_017, cacheWrite: 43_514, cacheWrite1h: 43_514 };
      expect(estimateCost(fable, tokens)).toBeCloseTo(0.89292425, 8);
    });

    it('splits a mixed cacheWrite between the 1h and 5m rates', () => {
      const tokens = { input: 0, output: 0, cacheWrite: 1000, cacheWrite1h: 400 };
      // 400 at 2x input (20/M) + 600 at the catalog cacheWrite rate (12.5/M).
      expect(estimateCost(fable, tokens)).toBeCloseTo((400 * 20 + 600 * 12.5) / 1_000_000, 12);
    });
  });
});

describe('PriceCatalog refresh', () => {
  it('writes the fetched catalog to the cache file and serves it', async () => {
    const cache = path.join(tmpDir(), 'models.dev.json');
    const catalog = new PriceCatalog(cache, { fetchImpl: fakeFetch({ deepseek: { models: { 'deepseek-flash': { cost: { input: 1, output: 2 } } } } }) });
    await catalog.refresh();
    expect(fs.existsSync(cache)).toBe(true);
    expect(catalog.priceFor('opencode', 'deepseek/deepseek-flash')).toEqual({ input: 1, output: 2 });
    expect(catalog.needsRefresh()).toBe(false);
  });

  it('falls back to the cached copy when the fetch fails (offline)', async () => {
    const cache = path.join(tmpDir(), 'models.dev.json');
    fs.copyFileSync(FIXTURE, cache);
    const catalog = new PriceCatalog(cache, { fetchImpl: offlineFetch() });
    expect(catalog.load()).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await catalog.refresh();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping the cached copy'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
    expect(catalog.priceFor('codex', 'gpt-5.6-terra')).toMatchObject({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 });
  });

  it('has no prices when neither a cached copy nor a fetch is available', async () => {
    const catalog = new PriceCatalog(path.join(tmpDir(), 'missing.json'), { fetchImpl: offlineFetch() });
    expect(catalog.load()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await catalog.refresh();
    } finally {
      warn.mockRestore();
    }
    expect(catalog.priceFor('codex', 'gpt-5.6-terra')).toBeNull();
    expect(catalog.needsRefresh()).toBe(true);
  });

  it('is stale with no cached copy and once the copy is older than the refresh interval', () => {
    const cache = path.join(tmpDir(), 'models.dev.json');
    fs.copyFileSync(FIXTURE, cache);
    const now = Date.now();
    fs.utimesSync(cache, new Date(now - 50), new Date(now - 50));
    const fresh = new PriceCatalog(cache, { now: () => now, refreshMs: 100 });
    fresh.load();
    expect(fresh.needsRefresh()).toBe(false);
    const stale = new PriceCatalog(cache, { now: () => now + 100, refreshMs: 100 });
    stale.load();
    expect(stale.needsRefresh()).toBe(true);
  });
});
