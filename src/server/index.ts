import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { countOpenGaps } from "../candles/gapFill.js";
import { HourlyRestSyncScheduler } from "../candles/sync.js";
import {
  HOST,
  HOURLY_SYNC_MS,
  LATEST_SYNC_MS,
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
  credentialsStatus,
  setPolymarketCredentials,
} from "../polymarket/credentials.js";
import { refreshMarketMetadata } from "../polymarket/markets.js";

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

async function main(): Promise<void> {
  getDb();
  fs.mkdirSync(publicDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: ClientMsg) => {
    const raw = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(raw);
    }
  };

  const broadcastLatestCandles = () => {
    for (const pair of PAIRS) {
      for (const window of WINDOWS) {
        const latest = getCandles(pair, window, 3);
        for (const candle of latest) {
          broadcast({ type: "candle", candle });
        }
      }
    }
  };

  const sync = new HourlyRestSyncScheduler({
    onLog: (msg) => console.log(msg),
    onComplete: (result) => {
      broadcast({
        type: "status",
        status: `rest-sync:${result.reason}:imported=${result.imported}`,
      });
      broadcastLatestCandles();
    },
  });

  app.get("/api/health", (_req, res) => {
    const last = sync.getLastResult();
    const gaps = countOpenGaps(PAIRS, 2 * 60 * 60 * 1000);
    const creds = credentialsStatus();
    const ageMs = last ? Date.now() - last.finishedAtMs : null;
    res.json({
      ok: true,
      service: "Datafeed",
      source: "polymarket-rest-hourly",
      chainlinkRtds: "disconnected",
      sync: {
        mode: "hourly-rest",
        hourlyIntervalMs: HOURLY_SYNC_MS,
        latestIntervalMs: LATEST_SYNC_MS,
        lastReason: last?.reason ?? null,
        lastFinishedAtMs: last?.finishedAtMs ?? null,
        lastAgeMs: ageMs,
        lastImported: last?.imported ?? null,
        lastAggregated: last?.aggregated ?? null,
        healthy: ageMs != null && ageMs < HOURLY_SYNC_MS + 10 * 60_000,
      },
      credentials: {
        configured: creds.configured,
        source: creds.source,
        hasApiKey: creds.hasApiKey,
        hasApiSecret: creds.hasApiSecret,
        hasApiPassphrase: creds.hasApiPassphrase,
      },
      gaps: {
        lookbackHours: 2,
        missingCandles: gaps.total,
        bySeries: gaps.bySeries,
      },
      stats: getStats(),
    });
  });

  app.get("/api/credentials", (_req, res) => {
    res.json(credentialsStatus());
  });

  app.post("/api/credentials", (req, res) => {
    const body = (req.body ?? {}) as {
      apiKey?: string;
      apiSecret?: string;
      apiPassphrase?: string;
    };
    const saved = setPolymarketCredentials({
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret : undefined,
      apiPassphrase:
        typeof body.apiPassphrase === "string" ? body.apiPassphrase : undefined,
    });
    res.json({
      ok: true,
      ...credentialsStatus(),
      // Never echo secrets back; only confirm lengths.
      apiKeyLength: saved.apiKey.length,
      apiSecretLength: saved.apiSecret.length,
      apiPassphraseLength: saved.apiPassphrase.length,
    });
  });

  app.post("/api/sync", async (_req, res) => {
    try {
      const result = await sync.trigger("manual");
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
        source: "polymarket-rest",
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
    res.json({
      pairs: PAIRS,
      windows: WINDOWS,
      restWindows: ["5m", "15m"],
      aggregateWindows: ["30m", "1h", "4h", "1d"],
    });
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
        status: "rest-hourly",
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

  // HOST=0.0.0.0 for Railway/containers; override with HOST=:: for local IPv6 localhost.
  server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
    console.log(`[datafeed] listening on http://${HOST}:${PORT}`);
    console.log(
      "[datafeed] Chainlink RTDS disconnected — Polymarket REST hourly sync",
    );
  });

  // No Chainlink RTDS — candles come from Polymarket REST only.
  sync.start();
  broadcast({ type: "status", status: "rest-hourly" });

  refreshMarketMetadata()
    .then(() => {
      console.log("[meta] refreshed Polymarket resolution sources");
      broadcast({
        type: "meta",
        meta: getAllMarketMeta().map(({ rawJson: _raw, ...rest }) => rest),
      });
    })
    .catch((err) => console.error("[meta] refresh failed", err));

  setInterval(() => {
    refreshMarketMetadata().catch((err) =>
      console.error("[meta] refresh failed", err),
    );
  }, 5 * 60_000);

  const shutdown = () => {
    sync.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
