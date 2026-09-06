import {
  PAIR_META,
  POLYMARKET,
  TWAP_LOOKBACK_SECONDS,
  type Pair,
  type Window,
} from "../config.js";
import { upsertCandle, type CandleRow } from "../db.js";

export type PolymarketCandle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Datafeed/1.0 (Polymarket-only)",
      Referer: `${POLYMARKET.site}/`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Polymarket HTTP ${res.status}: ${text || url}`);
  }
  return (await res.json()) as T;
}

/** Official Polymarket Chainlink TWAP candles (5m / 15m only). */
export async function fetchChainlinkCandles(options: {
  pair: Pair;
  interval: "5m" | "15m";
  endTimeMs?: number;
  twapEnabled?: boolean;
  twapLookbackSeconds?: number;
}): Promise<PolymarketCandle[]> {
  const params = new URLSearchParams({
    symbol: PAIR_META[options.pair].symbol,
    interval: options.interval,
    limit: "30",
  });
  if (options.twapEnabled !== false) {
    params.set("twapEnabled", "true");
    params.set(
      "twapLookbackSeconds",
      String(options.twapLookbackSeconds ?? TWAP_LOOKBACK_SECONDS),
    );
  }
  if (options.endTimeMs != null) {
    params.set("endTime", String(options.endTimeMs));
  }
  const url = `${POLYMARKET.site}/api/chainlink-candles?${params}`;
  const data = await fetchJson<{ candles?: PolymarketCandle[] }>(url);
  return data.candles ?? [];
}

/** Polymarket TWAP price history for one market window. */
export async function fetchTwapPriceHistory(options: {
  pair: Pair;
  variant: "fiveminute" | "fifteen" | "hourly" | "daily" | "fourhour";
  eventStartTime: string;
  endDate?: string;
  twapEnabled?: boolean;
  twapLookbackSeconds?: number;
}): Promise<Array<{ timestamp: number; value: number }>> {
  const params = new URLSearchParams({
    symbol: PAIR_META[options.pair].symbol,
    variant: options.variant,
    eventStartTime: options.eventStartTime,
  });
  if (options.endDate) params.set("endDate", options.endDate);
  if (options.twapEnabled !== false) {
    params.set("twapEnabled", "true");
    params.set(
      "twapLookbackSeconds",
      String(options.twapLookbackSeconds ?? TWAP_LOOKBACK_SECONDS),
    );
  }
  const url = `${POLYMARKET.site}/api/crypto/price-history?${params}`;
  return fetchJson(url);
}

export async function seedShortWindowHistory(
  pair: Pair,
  window: "5m" | "15m",
  pages = 40,
): Promise<number> {
  let endTimeMs: number | undefined;
  let imported = 0;
  const seen = new Set<number>();

  for (let page = 0; page < pages; page++) {
    const candles = await fetchChainlinkCandles({
      pair,
      interval: window,
      endTimeMs,
    });
    if (!candles.length) break;

    for (const c of candles) {
      if (seen.has(c.time)) continue;
      seen.add(c.time);
      const row: CandleRow = {
        pair,
        window,
        openTimeMs: c.time * 1000,
        open: String(c.open),
        high: String(c.high),
        low: String(c.low),
        close: String(c.close),
        tickCount: 0,
        closed: Date.now() >= (c.time + (window === "5m" ? 300 : 900)) * 1000 ? 1 : 0,
        source: "polymarket-chainlink-candles",
        updatedAtMs: Date.now(),
      };
      upsertCandle(row);
      imported += 1;
    }

    const oldest = candles.reduce((min, c) => Math.min(min, c.time), candles[0].time);
    const nextEnd = oldest * 1000 - 1;
    if (endTimeMs != null && nextEnd >= endTimeMs) break;
    endTimeMs = nextEnd;
    if (candles.length < 30) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  return imported;
}

export function windowSupportsPolymarketCandles(
  window: Window,
): window is "5m" | "15m" {
  return window === "5m" || window === "15m";
}
