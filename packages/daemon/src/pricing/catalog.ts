import fs from 'node:fs';
import path from 'node:path';
import type { CostSource, HarnessName } from '@overseer/shared';
import type { TokenUsage } from '../harness/types';
import { log } from '../util/log';

/** The catalog opencode reads (`OPENCODE_MODELS_PATH` points it at this JSON); costs are USD per million tokens. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';
/** The cached copy is refreshed once a day; when the fetch fails the copy already on disk stays in use. */
export const REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const PER_MILLION = 1_000_000;

/** One higher price band from the catalog's `tiers`, applied to a response whose own input exceeds `size`. */
export interface ContextTier {
  size: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** This response's prices; `cacheRead`/`cacheWrite` are optional in the catalog, and `cost.reasoning` is ignored: opencode bills reasoning at the output price, not at it. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The catalog's `tiers` entries whose `tier.type` is `context`; opencode picks the largest matching `size`. */
  tiers?: ContextTier[];
  /** The catalog's `context_over_200k`, opencode's `experimentalOver200K`: applies only when no `tiers` entry matched. */
  contextOver200k?: Omit<ContextTier, 'size'>;
}

/** The one lookup the daemon needs; `null` means the model id is not in the catalog, never a close match. */
export interface PriceSource {
  priceFor(harness: HarnessName, model: string): ModelPrice | null;
  /** False while no copy has been read or fetched yet (no cache on disk, first refresh still pending or failed). Omitted: always ready. */
  loaded?(): boolean;
}

/** The provider a harness's model ids belong to. opencode names its provider in the id itself (`deepseek/deepseek-flash`). */
const PROVIDER_FOR_HARNESS: Record<HarnessName, string | null> = { claude: 'anthropic', codex: 'openai', opencode: null };

const key = (provider: string, model: string): string => `${provider}\u0000${model}`;

/** The price fields shared by the base cost, a `tiers` entry and `context_over_200k`; null when input/output are not numbers. */
function toBand(cost: Record<string, unknown>): Omit<ContextTier, 'size'> | null {
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return null;
  return {
    input: cost.input,
    output: cost.output,
    ...(typeof cost.cache_read === 'number' ? { cacheRead: cost.cache_read } : {}),
    ...(typeof cost.cache_write === 'number' ? { cacheWrite: cost.cache_write } : {}),
  };
}

/** The catalog's `tiers` entries with `tier.type === 'context'` and a numeric `tier.size`, in catalog order. */
function toTiers(raw: unknown): ContextTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: ContextTier[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown> | null;
    const meta = e?.tier as { type?: unknown; size?: unknown } | undefined;
    if (meta?.type !== 'context' || typeof meta.size !== 'number') continue;
    const band = e ? toBand(e) : null;
    if (band) tiers.push({ ...band, size: meta.size });
  }
  return tiers;
}

/**
 * The base per-million prices plus the catalog's context bands. `cost.reasoning` is deliberately ignored: opencode, the one
 * harness whose counter prices it at all, bills its reasoning slice at the output price in its own cost function and never
 * reads `cost.reasoning`. `tiers`/`context_over_200k` are carried here and selected per response by `selectContextPrice`.
 */
function toPrice(cost: unknown): ModelPrice | null {
  if (!cost || typeof cost !== 'object') return null;
  const c = cost as Record<string, unknown>;
  if (typeof c.input !== 'number' || typeof c.output !== 'number') return null;
  const tiers = toTiers(c.tiers);
  const over = c.context_over_200k && typeof c.context_over_200k === 'object' ? toBand(c.context_over_200k as Record<string, unknown>) : null;
  return {
    input: c.input,
    output: c.output,
    ...(typeof c.cache_read === 'number' ? { cacheRead: c.cache_read } : {}),
    ...(typeof c.cache_write === 'number' ? { cacheWrite: c.cache_write } : {}),
    ...(tiers.length ? { tiers } : {}),
    ...(over ? { contextOver200k: over } : {}),
  };
}

/**
 * Exactly opencode's own tier selection: of its `cost.tiers` entries with `tier.type === 'context'`, the one with the
 * largest `tier.size` that this response's raw input (`inputTokens`, cached tokens included) exceeds; else
 * `cost.context_over_200k` (`experimentalOver200K`) when `inputTokens > 200000` and no entry matched; else the base prices.
 * Both comparisons are strict, matching opencode. Returns a price without bands, so `estimateCost` cannot select twice.
 */
export function selectContextPrice(price: ModelPrice, inputTokens: number): ModelPrice {
  const hit = (price.tiers ?? []).filter((t) => inputTokens > t.size).sort((a, b) => b.size - a.size)[0];
  const band = hit ?? (price.contextOver200k && inputTokens > 200_000 ? price.contextOver200k : null);
  if (!band) return price;
  return {
    input: band.input,
    output: band.output,
    ...(band.cacheRead !== undefined ? { cacheRead: band.cacheRead } : {}),
    ...(band.cacheWrite !== undefined ? { cacheWrite: band.cacheWrite } : {}),
  };
}

/** Every priced model in the catalog, keyed by provider and exact model id; an entry without numeric `input`/`output` prices is skipped. */
export function parsePrices(json: unknown): Map<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  if (!json || typeof json !== 'object') return prices;
  for (const [provider, entry] of Object.entries(json as Record<string, unknown>)) {
    const models = (entry as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      const price = toPrice((model as { cost?: unknown } | null)?.cost);
      if (price) prices.set(key(provider, id), price);
    }
  }
  return prices;
}

export interface EstimateOptions {
  /**
   * The harness reports `input` as the total input, with the cache counters inside it (Codex). Subtract them, or the cached
   * slice is billed once at the cache rate and again at the input rate. Claude and opencode report input without cache tokens.
   */
  inputIncludesCacheTokens?: boolean;
  /**
   * The harness reports `reasoning` outside `output` (opencode) and its own cost function bills that slice at the output
   * price, ignoring `cost.reasoning`, so bill it here the same way. Claude Code and Codex count reasoning inside
   * `output_tokens`, so billing it there would double count.
   */
  billReasoning?: boolean;
}

/**
 * `input`, `output`, cache-read and cache-write tokens times the model's per-million prices. `reasoning` is billed only when
 * `billReasoning` is set (opencode, whose token model keeps it outside `output`), and at the `output` price, matching the
 * CLI's own cost function; Claude Code and Codex count reasoning inside `output_tokens`, so there it must not be added
 * again. Returns null when the harness reported no token counters, so a usage-less session is not priced at zero.
 *
 * The caller passes the price to bill; a context tier is selected before this call by `selectContextPrice`, which needs the
 * response's own input size. Codex never selects one (its stream reports no per-request context), so a codex session whose
 * requests crossed ~272k tokens is priced low by up to 2x; opencode selects per response. See CLAUDE.md.
 *
 * `tokens.cacheWrite1h` (Claude only) is the slice of `cacheWrite` written with a 1-hour cache TTL, billed at 2x the input
 * rate per Anthropic's documented multiplier; the rest of `cacheWrite` bills at the catalog's 5-minute `cacheWrite` rate.
 */
export function estimateCost(price: ModelPrice, tokens: TokenUsage, opts: EstimateOptions = {}): number | null {
  const counts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite];
  if (!counts.some((n) => typeof n === 'number')) return null;
  const t = (n?: number): number => (typeof n === 'number' ? n : 0);
  const cacheRead = t(tokens.cacheRead);
  const cacheWrite = t(tokens.cacheWrite);
  const cacheWrite1h = Math.min(t(tokens.cacheWrite1h), cacheWrite);
  const cacheWriteRest = cacheWrite - cacheWrite1h;
  const input = Math.max(0, t(tokens.input) - (opts.inputIncludesCacheTokens ? cacheRead + cacheWrite : 0));
  return (
    input * price.input +
    t(tokens.output) * price.output +
    cacheRead * (price.cacheRead ?? 0) +
    cacheWriteRest * (price.cacheWrite ?? 0) +
    cacheWrite1h * (2 * price.input) +
    (opts.billReasoning ? t(tokens.reasoning) * price.output : 0)
  ) / PER_MILLION;
}

/** The reported figure wins when the CLI gave one, else the estimate, else the model is not in the catalog. */
export function costSource(reported: number | null, estimated: number | null): CostSource {
  if (reported !== null) return 'reported';
  if (estimated !== null) return 'estimated';
  return 'unknown';
}

export interface PriceCatalogOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
}

/**
 * The models.dev price catalog: fetched once, cached under the data directory, refreshed daily, and served from the cached
 * copy when the fetch fails. Tests inject a fixture file and a fake fetch, so nothing here reaches the network.
 */
export class PriceCatalog implements PriceSource {
  private prices = new Map<string, ModelPrice>();
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private cacheFile: string, options: PriceCatalogOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? REFRESH_MS;
  }

  /** Reads the cached copy; returns whether one was loaded. Never touches the network. */
  load(): boolean {
    try {
      const text = fs.readFileSync(this.cacheFile, 'utf8');
      this.prices = parsePrices(JSON.parse(text));
      this.fetchedAt = fs.statSync(this.cacheFile).mtimeMs;
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a copy has been read from the cache or fetched; until then every price lookup answers null. */
  loaded(): boolean {
    return this.fetchedAt !== 0;
  }

  /** True when no copy was loaded, or the copy is older than the refresh interval. */
  needsRefresh(): boolean {
    return this.fetchedAt === 0 || this.now() - this.fetchedAt >= this.refreshMs;
  }

  /** Fetches and caches a fresh catalog; on any failure the already-loaded copy stays in use. */
  async refresh(): Promise<void> {
    try {
      const response = await this.fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const prices = parsePrices(JSON.parse(text));
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.cacheFile);
      this.prices = prices;
      this.fetchedAt = this.now();
    } catch (err) {
      log.warn('pricing: could not refresh the models.dev catalog; keeping the cached copy', err);
    }
  }

  /** Loads the cache, refreshes it when stale, then keeps it fresh on an unref'd daily timer. */
  start(): void {
    this.load();
    if (this.needsRefresh()) void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolves a model id to its price, exactly. An id with a provider prefix (`deepseek/deepseek-flash`) uses that provider;
   * otherwise claude reads anthropic and codex openai. A harness with no fixed provider and a bare id is served only when
   * exactly one provider carries that id, so an ambiguous or unknown id is never guessed.
   */
  priceFor(harness: HarnessName, model: string): ModelPrice | null {
    const slash = model.indexOf('/');
    if (slash > 0) return this.prices.get(key(model.slice(0, slash), model.slice(slash + 1))) ?? null;
    const provider = PROVIDER_FOR_HARNESS[harness];
    if (provider) return this.prices.get(key(provider, model)) ?? null;
    let found: ModelPrice | null = null;
    const suffix = `\u0000${model}`;
    for (const [k, price] of this.prices) {
      if (!k.endsWith(suffix)) continue;
      if (found) return null;
      found = price;
    }
    return found;
  }
}
