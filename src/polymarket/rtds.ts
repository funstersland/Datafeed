import WebSocket from "ws";
import {
  PAIR_META,
  PAIRS,
  POLYMARKET,
  TWAP_LOOKBACK_SECONDS,
  type Pair,
} from "../config.js";
import { insertTwapTick, type TwapTick } from "../db.js";

export type TwapUpdateHandler = (tick: TwapTick) => void;

const SYMBOL_TO_PAIR = new Map(
  PAIRS.map((pair) => [PAIR_META[pair].rtdsSymbol, pair] as const),
);

/**
 * TWAP updates arrive about once per second per symbol. Treat silence longer
 * than this as a stalled socket and force reconnect + REST gap fill.
 */
const STALE_MS = 12_000;
const WATCHDOG_MS = 3_000;
const PING_MS = 5_000;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

export class PolymarketTwapFeed {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private connectionId = 0;
  private lastTickAtMs = 0;
  private lastMessageAtMs = 0;
  private everConnected = false;
  private readonly onTick: TwapUpdateHandler;
  private readonly onStatus: (status: string) => void;
  private readonly onStale: (ageMs: number) => void;
  private readonly onReconnect: (reason: string) => void;

  constructor(handlers: {
    onTick: TwapUpdateHandler;
    onStatus?: (status: string) => void;
    /** Fired when the socket is considered stale (before reconnect). */
    onStale?: (ageMs: number) => void;
    /** Fired after a successful (re)connect and subscribe. */
    onReconnect?: (reason: string) => void;
  }) {
    this.onTick = handlers.onTick;
    this.onStatus = handlers.onStatus ?? (() => undefined);
    this.onStale = handlers.onStale ?? (() => undefined);
    this.onReconnect = handlers.onReconnect ?? (() => undefined);
  }

  start(): void {
    this.stopped = false;
    this.connect("start");
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
  }

  /** Last accepted TWAP tick time (0 if none yet). */
  getLastTickAtMs(): number {
    return this.lastTickAtMs;
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.watchdogTimer = null;
    this.reconnectTimer = null;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    } catch {
      // ignore
    }
  }

  private connect(reason: string): void {
    if (this.stopped) return;
    if (this.connecting) return;
    this.connecting = true;
    this.clearTimers();
    this.closeSocket();

    const connectionId = ++this.connectionId;
    this.onStatus(`connecting:${reason}`);
    const ws = new WebSocket(POLYMARKET.rtds);
    this.ws = ws;

    ws.on("open", () => {
      if (connectionId !== this.connectionId || this.stopped) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.lastMessageAtMs = Date.now();
      this.onStatus("connected");
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: POLYMARKET.twapTopic,
              type: "update",
            },
          ],
        }),
      );
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_MS);
      this.watchdogTimer = setInterval(() => {
        this.checkWatchdog(connectionId);
      }, WATCHDOG_MS);

      if (this.everConnected || reason !== "start") {
        this.onReconnect(reason);
      }
      this.everConnected = true;
    });

    ws.on("message", (raw) => {
      if (connectionId !== this.connectionId) return;
      this.lastMessageAtMs = Date.now();
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      if (!text || text === "PONG" || text === "pong") return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("close", () => {
      if (connectionId !== this.connectionId) return;
      this.connecting = false;
      this.onStatus("disconnected");
      this.scheduleReconnect("close");
    });

    ws.on("error", (err) => {
      if (connectionId !== this.connectionId) return;
      this.onStatus(`error:${err?.message || "socket"}`);
      try {
        ws.close();
      } catch {
        // ignore — close handler schedules reconnect
      }
    });
  }

  private checkWatchdog(connectionId: number): void {
    if (this.stopped || connectionId !== this.connectionId) return;
    const now = Date.now();
    // Prefer tick freshness once we've received at least one update.
    const anchor = this.lastTickAtMs || this.lastMessageAtMs;
    if (!anchor) return;
    const ageMs = now - anchor;
    if (ageMs < STALE_MS) return;
    this.onStatus(`stale:${Math.round(ageMs / 1000)}s — forcing reconnect`);
    this.onStale(ageMs);
    this.scheduleReconnect("stale");
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.clearTimers();
    this.closeSocket();
    this.connecting = false;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      MAX_RECONNECT_MS,
      MIN_RECONNECT_MS * 2 ** Math.min(attempt, 5),
    );
    this.onStatus(`reconnect in ${delay}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(reason);
    }, delay);
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const data = msg as {
      topic?: string;
      type?: string;
      timestamp?: number;
      payload?: {
        symbol?: string;
        value?: number | string;
        full_accuracy_value?: string;
        timestamp?: number;
        window_s?: number;
        data?: Array<{
          timestamp?: number;
          value?: number | string;
        }>;
      };
      error?: string;
      message?: string;
    };

    if (data.error || (data.message && !data.topic)) {
      this.onStatus(`server:${data.error ?? data.message}`);
      // Force a clean reconnect on server-side network faults.
      this.scheduleReconnect("server");
      return;
    }

    if (data.topic !== POLYMARKET.twapTopic) return;

    // Filtered subscribe can return a batch snapshot under payload.data.
    const batch = data.payload?.data;
    if (Array.isArray(batch) && data.payload?.symbol) {
      for (const point of batch) {
        if (point?.timestamp == null || point.value == null) continue;
        this.emitTick({
          symbol: data.payload.symbol,
          value: point.value,
          timestamp: point.timestamp,
          full_accuracy_value: data.payload.full_accuracy_value,
          window_s: data.payload.window_s,
        });
      }
      return;
    }

    if (data.type !== "update") return;

    const payload = data.payload;
    if (!payload?.symbol || payload.value == null || payload.timestamp == null) {
      return;
    }

    this.emitTick({
      symbol: payload.symbol,
      value: payload.value,
      timestamp: payload.timestamp,
      full_accuracy_value: payload.full_accuracy_value,
      window_s: payload.window_s,
      publishedAtMs: data.timestamp,
    });
  }

  private emitTick(payload: {
    symbol: string;
    value: number | string;
    timestamp: number;
    full_accuracy_value?: string;
    window_s?: number;
    publishedAtMs?: number;
  }): void {
    const pair = SYMBOL_TO_PAIR.get(normalizeSymbol(payload.symbol));
    if (!pair) return;

    const tick: TwapTick = {
      pair,
      observedAtMs: Number(payload.timestamp),
      publishedAtMs: Number(payload.publishedAtMs ?? Date.now()),
      value: String(payload.value),
      fullAccuracyValue: payload.full_accuracy_value
        ? String(payload.full_accuracy_value)
        : null,
      windowSeconds: Number(payload.window_s ?? TWAP_LOOKBACK_SECONDS),
    };

    this.lastTickAtMs = Date.now();
    insertTwapTick(tick);
    this.onTick(tick);
  }
}
