import { PAIRS, WINDOW_SECONDS, type Pair, type Window } from "../config.js";
import { getCandle, getCandles, upsertCandle, type CandleRow } from "../db.js";
import {
  fetchPolymarketCandles,
  windowSupportsPolymarketCandles,
} from "../polymarket/candlesApi.js";

export type GapFillResult = {
  pair: Pair;
  window: Window;
  missingBefore: number;
  filled: number;
  pages: number;
};

function stepMs(window: "5m" | "15m"): number {
  return WINDOW_SECONDS[window] * 1000;
}

function alignOpenMs(ms: number, window: "5m" | "15m"): number {
  const step = stepMs(window);
  return ms - (ms % step);
}

/** Expected open times from `fromOpenMs` through current bucket (inclusive). */
export function expectedOpenTimes(
  window: "5m" | "15m",
  fromOpenMs: number,
  throughMs: number,
): number[] {
  const step = stepMs(window);
  const start = alignOpenMs(fromOpenMs, window);
  const end = alignOpenMs(throughMs, window);
  const out: number[] = [];
  for (let t = start; t <= end; t += step) out.push(t);
  return out;
}

/** Find missing candle open times in the recent lookback window. */
export function findMissingOpenTimes(
  pair: Pair,
  window: "5m" | "15m",
  lookbackMs = 6 * 60 * 60 * 1000,
): number[] {
  const now = Date.now();
  const fromMs = now - lookbackMs;
  const expected = expectedOpenTimes(window, fromMs, now);
  if (!expected.length) return [];

  const existing = new Set(
    getCandles(pair, window, expected.length + 50).map((c) => c.openTimeMs),
  );
  return expected.filter((t) => !existing.has(t));
}

function toRow(
  pair: Pair,
  window: "5m" | "15m",
  c: { time: number; open: number; high: number; low: number; close: number },
): CandleRow {
  const openTimeMs = c.time * 1000;
  const durationMs = stepMs(window);
  return {
    pair,
    window,
    openTimeMs,
    open: String(c.open),
    high: String(c.high),
    low: String(c.low),
    close: String(c.close),
    tickCount: 0,
    closed: Date.now() >= openTimeMs + durationMs ? 1 : 0,
    source: "polymarket-rest-candles",
    updatedAtMs: Date.now(),
  };
}

/**
 * Import a Polymarket candle without wiping a live RTDS candle that already
 * has ticks for the still-open bucket.
 */
export function importChainlinkCandlePreservingLive(
  pair: Pair,
  window: "5m" | "15m",
  c: { time: number; open: number; high: number; low: number; close: number },
): "inserted" | "updated" | "skipped-live" {
  const row = toRow(pair, window, c);
  const existing = getCandle(pair, window, row.openTimeMs);
  // REST-only mode: always upsert Polymarket official OHLC.
  upsertCandle(row);
  return existing ? "updated" : "inserted";
}

/**
 * Pull Polymarket REST pages until recent missing 5m/15m opens are filled
 * (or pages exhausted). Also refreshes closed OHLC from the official series.
 */
export async function fillCandleGaps(
  pair: Pair,
  window: "5m" | "15m",
  options?: { lookbackMs?: number; maxPages?: number },
): Promise<GapFillResult> {
  const lookbackMs = options?.lookbackMs ?? 6 * 60 * 60 * 1000;
  const maxPages = options?.maxPages ?? 8;
  const need = new Set(findMissingOpenTimes(pair, window, lookbackMs));
  const missingBefore = need.size;

  let endTimeMs: number | undefined;
  let filled = 0;
  let pages = 0;
  const seen = new Set<number>();

  for (let page = 0; page < maxPages; page++) {
    const candles = await fetchPolymarketCandles({
      pair,
      interval: window,
      endTimeMs,
    });
    if (!candles.length) break;
    pages += 1;

    for (const c of candles) {
      if (seen.has(c.time)) continue;
      seen.add(c.time);
      const openTimeMs = c.time * 1000;
      const wasMissing = need.has(openTimeMs);
      const action = importChainlinkCandlePreservingLive(pair, window, c);
      if (wasMissing && action !== "skipped-live") {
        need.delete(openTimeMs);
        filled += 1;
      }
    }

    // Stop early once recent gaps are gone.
    if (!need.size) break;

    const oldest = candles.reduce(
      (min, c) => Math.min(min, c.time),
      candles[0].time,
    );
    const nextEnd = oldest * 1000 - 1;
    if (endTimeMs != null && nextEnd >= endTimeMs) break;
    endTimeMs = nextEnd;
    if (candles.length < 30) break;
    await new Promise((r) => setTimeout(r, 80));
  }

  return { pair, window, missingBefore, filled, pages };
}

export async function fillAllCandleGaps(options?: {
  lookbackMs?: number;
  maxPages?: number;
  pairs?: readonly Pair[];
}): Promise<GapFillResult[]> {
  const pairs = options?.pairs ?? PAIRS;
  const results: GapFillResult[] = [];
  for (const pair of pairs) {
    for (const window of ["5m", "15m"] as const) {
      if (!windowSupportsPolymarketCandles(window)) continue;
      try {
        results.push(await fillCandleGaps(pair, window, options));
      } catch (err) {
        console.error(`[gap] ${pair} ${window} failed`, err);
        results.push({
          pair,
          window,
          missingBefore: -1,
          filled: 0,
          pages: 0,
        });
      }
    }
  }
  return results;
}

/** Count remaining gaps in the lookback for health reporting. */
export function countOpenGaps(
  pairs: readonly Pair[] = PAIRS,
  lookbackMs = 2 * 60 * 60 * 1000,
): {
  total: number;
  bySeries: Array<{ pair: Pair; window: Window; missing: number }>;
} {
  const bySeries: Array<{ pair: Pair; window: Window; missing: number }> = [];
  let total = 0;
  for (const pair of pairs) {
    for (const window of ["5m", "15m"] as const) {
      const missing = findMissingOpenTimes(pair, window, lookbackMs).length;
      total += missing;
      if (missing > 0) bySeries.push({ pair, window, missing });
    }
  }
  return { total, bySeries };
}
