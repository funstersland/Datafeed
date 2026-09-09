import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  DB_PATH,
  MAX_CANDLES_PER_SERIES,
  type Pair,
  type Window,
} from "./config.js";

export type TwapTick = {
  pair: Pair;
  observedAtMs: number;
  publishedAtMs: number;
  value: string;
  fullAccuracyValue: string | null;
  windowSeconds: number;
};

export type CandleRow = {
  pair: Pair;
  window: Window;
  openTimeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  tickCount: number;
  closed: number;
  source: string;
  updatedAtMs: number;
};

export type MarketMetaRow = {
  pair: Pair;
  window: Window;
  seriesSlug: string | null;
  marketSlug: string | null;
  title: string | null;
  resolutionSource: string | null;
  twapEnabled: number;
  twapLookbackSeconds: number | null;
  cryptoMarketConfigId: string | null;
  rawJson: string | null;
  updatedAtMs: number;
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const abs = path.resolve(DB_PATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS twap_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER NOT NULL,
      value TEXT NOT NULL,
      full_accuracy_value TEXT,
      window_seconds INTEGER NOT NULL,
      UNIQUE(pair, observed_at_ms, value, full_accuracy_value)
    );

    CREATE INDEX IF NOT EXISTS idx_twap_ticks_pair_obs
      ON twap_ticks(pair, observed_at_ms);

    CREATE TABLE IF NOT EXISTS candles (
      pair TEXT NOT NULL,
      window TEXT NOT NULL,
      open_time_ms INTEGER NOT NULL,
      open TEXT NOT NULL,
      high TEXT NOT NULL,
      low TEXT NOT NULL,
      close TEXT NOT NULL,
      tick_count INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (pair, window, open_time_ms)
    );

    CREATE INDEX IF NOT EXISTS idx_candles_pair_window_time
      ON candles(pair, window, open_time_ms DESC);

    CREATE TABLE IF NOT EXISTS market_meta (
      pair TEXT NOT NULL,
      window TEXT NOT NULL,
      series_slug TEXT,
      market_slug TEXT,
      title TEXT,
      resolution_source TEXT,
      twap_enabled INTEGER NOT NULL DEFAULT 0,
      twap_lookback_seconds INTEGER,
      crypto_market_config_id TEXT,
      raw_json TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (pair, window)
    );

    CREATE TABLE IF NOT EXISTS ingest_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

export function insertTwapTick(tick: TwapTick): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO twap_ticks
        (pair, observed_at_ms, published_at_ms, value, full_accuracy_value, window_seconds)
       VALUES (@pair, @observedAtMs, @publishedAtMs, @value, @fullAccuracyValue, @windowSeconds)`,
    )
    .run(tick);
  return result.changes > 0;
}

export function upsertCandle(candle: CandleRow): void {
  const database = getDb();
  const upsert = database.transaction((row: CandleRow) => {
    database
      .prepare(
        `INSERT INTO candles
          (pair, window, open_time_ms, open, high, low, close, tick_count, closed, source, updated_at_ms)
         VALUES
          (@pair, @window, @openTimeMs, @open, @high, @low, @close, @tickCount, @closed, @source, @updatedAtMs)
         ON CONFLICT(pair, window, open_time_ms) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          tick_count = excluded.tick_count,
          closed = excluded.closed,
          source = excluded.source,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run(row);

    // Keep at most MAX candles per series by deleting the oldest open_time rows.
    const count = database
      .prepare(
        `SELECT COUNT(*) AS c FROM candles WHERE pair = ? AND window = ?`,
      )
      .get(row.pair, row.window) as { c: number };

    if (count.c > MAX_CANDLES_PER_SERIES) {
      const overflow = count.c - MAX_CANDLES_PER_SERIES;
      database
        .prepare(
          `DELETE FROM candles
           WHERE rowid IN (
             SELECT rowid FROM candles
             WHERE pair = ? AND window = ?
             ORDER BY open_time_ms ASC
             LIMIT ?
           )`,
        )
        .run(row.pair, row.window, overflow);
    }
  });
  upsert(candle);
}

export function getCandles(
  pair: Pair,
  window: Window,
  limit = 500,
): CandleRow[] {
  const rows = getDb()
    .prepare(
      `SELECT pair, window, open_time_ms AS openTimeMs, open, high, low, close,
              tick_count AS tickCount, closed, source, updated_at_ms AS updatedAtMs
       FROM candles
       WHERE pair = ? AND window = ?
       ORDER BY open_time_ms DESC
       LIMIT ?`,
    )
    .all(pair, window, limit) as CandleRow[];
  return rows.reverse();
}

export function getLatestCandle(
  pair: Pair,
  window: Window,
): CandleRow | undefined {
  return getDb()
    .prepare(
      `SELECT pair, window, open_time_ms AS openTimeMs, open, high, low, close,
              tick_count AS tickCount, closed, source, updated_at_ms AS updatedAtMs
       FROM candles
       WHERE pair = ? AND window = ?
       ORDER BY open_time_ms DESC
       LIMIT 1`,
    )
    .get(pair, window) as CandleRow | undefined;
}

export function getCandle(
  pair: Pair,
  window: Window,
  openTimeMs: number,
): CandleRow | undefined {
  return getDb()
    .prepare(
      `SELECT pair, window, open_time_ms AS openTimeMs, open, high, low, close,
              tick_count AS tickCount, closed, source, updated_at_ms AS updatedAtMs
       FROM candles
       WHERE pair = ? AND window = ? AND open_time_ms = ?
       LIMIT 1`,
    )
    .get(pair, window, openTimeMs) as CandleRow | undefined;
}

export function upsertMarketMeta(row: MarketMetaRow): void {
  getDb()
    .prepare(
      `INSERT INTO market_meta
        (pair, window, series_slug, market_slug, title, resolution_source,
         twap_enabled, twap_lookback_seconds, crypto_market_config_id, raw_json, updated_at_ms)
       VALUES
        (@pair, @window, @seriesSlug, @marketSlug, @title, @resolutionSource,
         @twapEnabled, @twapLookbackSeconds, @cryptoMarketConfigId, @rawJson, @updatedAtMs)
       ON CONFLICT(pair, window) DO UPDATE SET
         series_slug = excluded.series_slug,
         market_slug = excluded.market_slug,
         title = excluded.title,
         resolution_source = excluded.resolution_source,
         twap_enabled = excluded.twap_enabled,
         twap_lookback_seconds = excluded.twap_lookback_seconds,
         crypto_market_config_id = excluded.crypto_market_config_id,
         raw_json = excluded.raw_json,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(row);
}

export function getAllMarketMeta(): MarketMetaRow[] {
  return getDb()
    .prepare(
      `SELECT pair, window, series_slug AS seriesSlug, market_slug AS marketSlug,
              title, resolution_source AS resolutionSource, twap_enabled AS twapEnabled,
              twap_lookback_seconds AS twapLookbackSeconds,
              crypto_market_config_id AS cryptoMarketConfigId,
              raw_json AS rawJson, updated_at_ms AS updatedAtMs
       FROM market_meta
       ORDER BY pair, window`,
    )
    .all() as MarketMetaRow[];
}

export function getStats(): {
  ticks: number;
  candles: number;
  bySeries: Array<{ pair: string; window: string; count: number }>;
} {
  const database = getDb();
  const ticks = (
    database.prepare(`SELECT COUNT(*) AS c FROM twap_ticks`).get() as {
      c: number;
    }
  ).c;
  const candles = (
    database.prepare(`SELECT COUNT(*) AS c FROM candles`).get() as {
      c: number;
    }
  ).c;
  const bySeries = database
    .prepare(
      `SELECT pair, window, COUNT(*) AS count
       FROM candles
       GROUP BY pair, window
       ORDER BY pair, window`,
    )
    .all() as Array<{ pair: string; window: string; count: number }>;
  return { ticks, candles, bySeries };
}

export function setIngestState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO ingest_state (key, value, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    )
    .run(key, value, Date.now());
}

export function getIngestState(key: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT value FROM ingest_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}
