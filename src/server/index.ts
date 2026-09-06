import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  aggregateHigherTimeframesFromFiveMinute,
  CandleEngine,
} from "../candles/engine.js";
import {
  HOST,
  PAIRS,
  PORT,
  WINDOWS,
  type Pair,
  type Window,
} from "../config.js";
import {
  getAllMarketMeta,
  getCandles,
  getDb,
  getStats,
  type CandleRow,
  type MarketMetaRow,
} from "../db.js";
import {
  seedShortWindowHistory,
  windowSupportsPolymarketCandles,
} from "../polymarket/candlesApi.js";
import { refreshMarketMetadata } from "../polymarket/markets.js";
import { PolymarketTwapFeed } from "../polymarket/rtds.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");

type PublicMarketMeta = Omit<MarketMetaRow, "rawJson">;

type ClientMsg =
  | { type: "hello"; status: string; stats: ReturnType<typeof getStats> }
  | { type: "status"; status: string }
  | { type: "candle"; candle: CandleRow }
  | { type: "meta"; meta: PublicMarketMeta[] };

function isPair(v: string): v is Pair {
  return (PAIRS as readonly string[]).includes(v);
}

function isWindow(v: string): v is Window {
  return (WINDOWS as readonly string[]).includes(v);
}

async function refreshLatestPolymarketCandles(): Promise<void> {
  for (const pair of PAIRS) {
    for (const window of WINDOWS) {
      if (!windowSupportsPolymarketCandles(window)) continue;
      try {
        // One latest page closes gaps created while earlier pairs were seeding.
        await seedShortWindowHistory(pair, window, 1);
      } catch (err) {
        console.error(`[seed] refresh ${pair} ${window} failed`, err);
      }
    }
    aggregateHigherTimeframesFromFiveMinute(pair);
  }
}

async function seedIfNeeded(): Promise<void> {
  const stats = getStats();
  if (stats.candles > 0) {
    console.log(`[seed] existing candles=${stats.candles}, refreshing latest Polymarket pages`);
    await refreshLatestPolymarketCandles();
    return;
  }

  console.log("[seed] importing Polymarket Chainlink TWAP candles (5m/15m)...");
  for (const pair of PAIRS) {
    for (const window of WINDOWS) {
      if (!windowSupportsPolymarketCandles(window)) continue;
      try {
        // 15 pages * 30 = up to 450 candles per series from Polymarket.
        const n = await seedShortWindowHistory(pair, window, 15);
        console.log(`[seed] ${pair} ${window}: imported ${n}`);
      } catch (err) {
        console.error(`[seed] ${pair} ${window} failed`, err);
      }
    }
    const agg = aggregateHigherTimeframesFromFiveMinute(pair);
    console.log(`[seed] ${pair} aggregated 1h/1d candles: ${agg}`);
  }
  await refreshLatestPolymarketCandles();
}

async function main(): Promise<void> {
  getDb();
  fs.mkdirSync(publicDir, { recursive: true });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: ClientMsg) => {
    const raw = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(raw);
    }
  };

  const engine = new CandleEngine((candle) => {
    broadcast({ type: "candle", candle });
  });

  const feed = new PolymarketTwapFeed({
    onStatus: (status) => {
      console.log(`[rtds] ${status}`);
      broadcast({ type: "status", status });
    },
    onTick: (tick) => {
      engine.applyTick(tick);
    },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "Datafeed", source: "polymarket-only" });
  });

  app.get("/api/stats", (_req, res) => {
    res.json(getStats());
  });

  app.get("/api/meta", (_req, res) => {
    res.json(
      getAllMarketMeta().map(({ rawJson: _raw, ...rest }) => rest),
    );
  });

  app.get("/api/candles/:pair/:window", (req, res) => {
    const pair = String(req.params.pair ?? "").toUpperCase();
    const window = String(req.params.window ?? "");
    if (!isPair(pair) || !isWindow(window)) {
      res.status(400).json({ error: "invalid pair or window" });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
    const meta = getAllMarketMeta().find(
      (m) => m.pair === pair && m.window === window,
    );
    res.json({
      pair,
      window,
      candles: getCandles(pair, window, limit),
      meta: meta
        ? (({ rawJson: _raw, ...rest }) => rest)(meta)
        : null,
    });
  });

  app.get("/api/candles/:pair/:window/download", (req, res) => {
    const pair = String(req.params.pair ?? "").toUpperCase();
    const window = String(req.params.window ?? "");
    if (!isPair(pair) || !isWindow(window)) {
      res.status(400).json({ error: "invalid pair or window" });
      return;
    }
    const format = String(req.query.format ?? "csv").toLowerCase();
    const limit = Math.min(
      Number(req.query.limit ?? 44_000) || 44_000,
      44_000,
    );
    const candles = getCandles(pair, window, limit);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `datafeed_${pair}_${window}_${stamp}`;

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${base}.json"`,
      );
      res.json({
        pair,
        window,
        source: "polymarket-twap",
        exportedAt: new Date().toISOString(),
        count: candles.length,
        candles,
      });
      return;
    }

    if (format !== "csv") {
      res.status(400).json({ error: "format must be csv or json" });
      return;
    }

    const header = [
      "open_time_iso",
      "open_time_ms",
      "open",
      "high",
      "low",
      "close",
      "tick_count",
      "closed",
      "source",
      "updated_at_ms",
    ].join(",");
    const lines = candles.map((c) =>
      [
        new Date(c.openTimeMs).toISOString(),
        c.openTimeMs,
        c.open,
        c.high,
        c.low,
        c.close,
        c.tickCount,
        c.closed,
        JSON.stringify(c.source),
        c.updatedAtMs,
      ].join(","),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${base}.csv"`,
    );
    res.send([header, ...lines].join("\n"));
  });

  app.get("/api/pairs", (_req, res) => {
    res.json({ pairs: PAIRS, windows: WINDOWS });
  });

  app.use(express.static(publicDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        status: "connected",
        stats: getStats(),
      } satisfies ClientMsg),
    );
    socket.send(
      JSON.stringify({
        type: "meta",
        meta: getAllMarketMeta().map(({ rawJson: _raw, ...rest }) => rest),
      } satisfies ClientMsg),
    );
    socket.on("close", () => clients.delete(socket));
  });

  // Live TWAP first — never wait on historical seed to start capturing.
  feed.start();

  // HOST=0.0.0.0 for Railway/containers; override with HOST=:: for local IPv6 localhost.
  server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
    console.log(`[datafeed] listening on http://${HOST}:${PORT}`);
  });

  refreshMarketMetadata()
    .then(() => {
      console.log("[meta] refreshed Polymarket resolution sources");
      broadcast({
        type: "meta",
        meta: getAllMarketMeta().map(({ rawJson: _raw, ...rest }) => rest),
      });
    })
    .catch((err) => console.error("[meta] refresh failed", err));

  seedIfNeeded()
    .then(() => console.log("[seed] complete"))
    .catch((err) => console.error("[seed] failed", err));

  setInterval(() => {
    refreshMarketMetadata().catch((err) =>
      console.error("[meta] refresh failed", err),
    );
  }, 5 * 60_000);

  const shutdown = () => {
    feed.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
