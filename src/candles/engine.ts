import { WINDOW_SECONDS, type Pair, type Window, WINDOWS } from "../config.js";
import {
  getCandles,
  getLatestCandle,
  upsertCandle,
  type CandleRow,
  type TwapTick,
} from "../db.js";

export type CandleUpdateHandler = (candle: CandleRow) => void;
export type CandleGapHandler = (gap: {
  pair: Pair;
  window: Window;
  fromOpenMs: number;
  toOpenMs: number;
  skippedBuckets: number;
}) => void;

function compareDecimal(a: string, b: string): number {
  return Number(a) - Number(b);
}

function maxDecimal(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? a : b;
}

function minDecimal(a: string, b: string): string {
  return compareDecimal(a, b) <= 0 ? a : b;
}

function etDateLabel(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Candle open times: 5m/15m/1h use UTC unix alignment; daily uses ET midnight. */
export function candleOpenTimeMs(observedAtMs: number, window: Window): number {
  if (window === "1d") {
    const label = etDateLabel(observedAtMs);
    const [y, m, d] = label.split("-").map(Number);
    let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
    let hi = Date.UTC(y, m - 1, d + 1, 12, 0, 0);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (etDateLabel(mid) < label) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const stepMs = WINDOW_SECONDS[window] * 1000;
  return observedAtMs - (observedAtMs % stepMs);
}

export class CandleEngine {
  private readonly onUpdate: CandleUpdateHandler;
  private readonly onGap: CandleGapHandler;
  private readonly open: Map<string, CandleRow> = new Map();

  constructor(
    onUpdate: CandleUpdateHandler,
    onGap?: CandleGapHandler,
  ) {
    this.onUpdate = onUpdate;
    this.onGap = onGap ?? (() => undefined);
  }

  private key(pair: Pair, window: Window): string {
    return `${pair}:${window}`;
  }

  applyTick(tick: TwapTick): CandleRow[] {
    return WINDOWS.map((window) => this.applyTickToWindow(tick, window));
  }

  private applyTickToWindow(tick: TwapTick, window: Window): CandleRow {
    const openTimeMs = candleOpenTimeMs(tick.observedAtMs, window);
    const key = this.key(tick.pair, window);
    let current = this.open.get(key);

    if (!current || current.openTimeMs !== openTimeMs) {
      if (current && current.openTimeMs < openTimeMs) {
        const step = WINDOW_SECONDS[window] * 1000;
        const skippedBuckets = Math.floor(
          (openTimeMs - current.openTimeMs) / step,
        ) - 1;
        if (skippedBuckets > 0) {
          this.onGap({
            pair: tick.pair,
            window,
            fromOpenMs: current.openTimeMs + step,
            toOpenMs: openTimeMs,
            skippedBuckets,
          });
        }
        current = { ...current, closed: 1, updatedAtMs: Date.now() };
        upsertCandle(current);
        this.onUpdate(current);
      }

      const existing = getLatestCandle(tick.pair, window);
      if (existing && existing.openTimeMs === openTimeMs) {
        current = existing;
      } else {
        current = {
          pair: tick.pair,
          window,
          openTimeMs,
          open: tick.value,
          high: tick.value,
          low: tick.value,
          close: tick.value,
          tickCount: 0,
          closed: 0,
          source: "polymarket-twap-rtds",
          updatedAtMs: Date.now(),
        };
      }
    }

    const preserveOpen =
      current.source.includes("chainlink") || current.tickCount > 0;

    const next: CandleRow = {
      ...current,
      open: preserveOpen ? current.open : tick.value,
      high: maxDecimal(current.high, tick.value),
      low: minDecimal(current.low, tick.value),
      close: tick.value,
      tickCount: current.tickCount + 1,
      closed: 0,
      source: current.source.includes("chainlink")
        ? "polymarket-chainlink-candles+rtds"
        : current.source.includes("aggregate")
          ? "polymarket-twap-aggregate+rtds"
          : "polymarket-twap-rtds",
      updatedAtMs: Date.now(),
    };

    this.open.set(key, next);
    upsertCandle(next);
    this.onUpdate(next);
    return next;
  }
}

/**
 * Build 1h / 1d candles from Polymarket 5m TWAP candles already in the DB.
 * Polymarket does not publish 1h/1d Chainlink candle charts; we derive them
 * from the same TWAP series used for 5m/15m.
 */
export function aggregateHigherTimeframesFromFiveMinute(pair: Pair): number {
  const five = getCandles(pair, "5m", 50_000);
  if (!five.length) return 0;

  let written = 0;
  for (const window of ["1h", "1d"] as const) {
    const buckets = new Map<number, CandleRow>();
    for (const c of five) {
      const openTimeMs = candleOpenTimeMs(c.openTimeMs, window);
      const existing = buckets.get(openTimeMs);
      if (!existing) {
        buckets.set(openTimeMs, {
          pair,
          window,
          openTimeMs,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          tickCount: c.tickCount,
          closed: 1,
          source: "polymarket-twap-aggregate-5m",
          updatedAtMs: Date.now(),
        });
      } else {
        existing.high = maxDecimal(existing.high, c.high);
        existing.low = minDecimal(existing.low, c.low);
        existing.close = c.close;
        existing.tickCount += c.tickCount;
        existing.updatedAtMs = Date.now();
      }
    }

    const now = Date.now();
    for (const row of buckets.values()) {
      row.closed = row.openTimeMs + WINDOW_SECONDS[window] * 1000 <= now ? 1 : 0;
      upsertCandle(row);
      written += 1;
    }
  }
  return written;
}
