import {
  HOURLY_SYNC_MS,
  LATEST_SYNC_MS,
  PAIRS,
  REST_CANDLE_WINDOWS,
  type Pair,
} from "../config.js";
import { deleteRtdsCandles } from "../db.js";
import { aggregateHigherTimeframesFromFiveMinute } from "./engine.js";
import { seedShortWindowHistory } from "../polymarket/candlesApi.js";
import { credentialsStatus } from "../polymarket/credentials.js";

export type SyncResult = {
  reason: string;
  startedAtMs: number;
  finishedAtMs: number;
  imported: number;
  aggregated: number;
  pairs: Pair[];
  credentialsConfigured: boolean;
};

export type SyncHandlers = {
  onLog?: (msg: string) => void;
  onComplete?: (result: SyncResult) => void;
};

/**
 * Pull 5m/15m from Polymarket REST for all pairs, then fold 5m → 30m/1h/4h/1d.
 * No Chainlink RTDS — REST only.
 */
export async function syncPolymarketRestCandles(options: {
  reason: string;
  pagesPerSeries: number;
  pairs?: readonly Pair[];
  onLog?: (msg: string) => void;
}): Promise<SyncResult> {
  const startedAtMs = Date.now();
  const pairs = options.pairs ?? PAIRS;
  const creds = credentialsStatus();
  let imported = 0;
  let aggregated = 0;

  options.onLog?.(
    `[sync] ${options.reason} start (pages=${options.pagesPerSeries}, keys=${creds.configured ? creds.source : "none"})`,
  );

  for (const pair of pairs) {
    for (const window of REST_CANDLE_WINDOWS) {
      try {
        const n = await seedShortWindowHistory(
          pair,
          window,
          options.pagesPerSeries,
        );
        imported += n;
        options.onLog?.(
          `[sync] ${pair} ${window}: upserted ${n} (pages≤${options.pagesPerSeries})`,
        );
      } catch (err) {
        console.error(`[sync] ${pair} ${window} failed`, err);
        options.onLog?.(
          `[sync] ${pair} ${window} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        // Always strip leftover RTDS tips even if a fetch failed mid-run.
        deleteRtdsCandles(pair, window);
      }
    }
    const agg = aggregateHigherTimeframesFromFiveMinute(pair);
    aggregated += agg;
    options.onLog?.(
      `[sync] ${pair} aggregated 30m/1h/4h/1d candles: ${agg}`,
    );
  }

  const finishedAtMs = Date.now();
  const result: SyncResult = {
    reason: options.reason,
    startedAtMs,
    finishedAtMs,
    imported,
    aggregated,
    pairs: [...pairs],
    credentialsConfigured: creds.configured,
  };
  options.onLog?.(
    `[sync] ${options.reason} done in ${finishedAtMs - startedAtMs}ms (imported=${imported}, aggregated=${aggregated})`,
  );
  return result;
}

export class HourlyRestSyncScheduler {
  private hourlyTimer: NodeJS.Timeout | null = null;
  private latestTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<SyncResult> | null = null;
  private lastResult: SyncResult | null = null;
  private readonly handlers: SyncHandlers;

  constructor(handlers: SyncHandlers = {}) {
    this.handlers = handlers;
  }

  getLastResult(): SyncResult | null {
    return this.lastResult;
  }

  isRunning(): boolean {
    return this.inFlight != null;
  }

  start(): void {
    void this.run("startup", 12);
    this.hourlyTimer = setInterval(() => {
      void this.run("hourly", 12);
    }, HOURLY_SYNC_MS);
    this.latestTimer = setInterval(() => {
      void this.run("latest", 4);
    }, LATEST_SYNC_MS);
  }

  stop(): void {
    if (this.hourlyTimer) clearInterval(this.hourlyTimer);
    if (this.latestTimer) clearInterval(this.latestTimer);
    this.hourlyTimer = null;
    this.latestTimer = null;
  }

  /** Manual / API trigger. */
  trigger(reason = "manual"): Promise<SyncResult> {
    return this.run(reason, 12);
  }

  private run(reason: string, pagesPerSeries: number): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const result = await syncPolymarketRestCandles({
          reason,
          pagesPerSeries,
          onLog: this.handlers.onLog,
        });
        this.lastResult = result;
        this.handlers.onComplete?.(result);
        return result;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
