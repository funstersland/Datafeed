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

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

export class PolymarketTwapFeed {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly onTick: TwapUpdateHandler;
  private readonly onStatus: (status: string) => void;

  constructor(handlers: {
    onTick: TwapUpdateHandler;
    onStatus?: (status: string) => void;
  }) {
    this.onTick = handlers.onTick;
    this.onStatus = handlers.onStatus ?? (() => undefined);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus("connecting");
    const ws = new WebSocket(POLYMARKET.rtds);
    this.ws = ws;

    ws.on("open", () => {
      this.onStatus("connected");
      const subscriptions = [
        {
          topic: POLYMARKET.twapTopic,
          type: "update",
        },
      ];
      ws.send(JSON.stringify({ action: "subscribe", subscriptions }));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 5_000);
    });

    ws.on("message", (raw) => {
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
      this.onStatus("disconnected");
      this.scheduleReconnect();
    });

    ws.on("error", () => {
      this.onStatus("error");
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 2_000);
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
      };
      error?: string;
      message?: string;
    };

    if (data.error || (data.message && !data.topic)) {
      this.onStatus(`server:${data.error ?? data.message}`);
      return;
    }

    if (data.topic !== POLYMARKET.twapTopic || data.type !== "update") return;
    const payload = data.payload;
    if (!payload?.symbol || payload.value == null || payload.timestamp == null) {
      return;
    }

    const pair = SYMBOL_TO_PAIR.get(normalizeSymbol(payload.symbol));
    if (!pair) return;

    const tick: TwapTick = {
      pair,
      observedAtMs: Number(payload.timestamp),
      publishedAtMs: Number(data.timestamp ?? Date.now()),
      value: String(payload.value),
      fullAccuracyValue: payload.full_accuracy_value
        ? String(payload.full_accuracy_value)
        : null,
      windowSeconds: Number(payload.window_s ?? TWAP_LOOKBACK_SECONDS),
    };

    insertTwapTick(tick);
    this.onTick(tick);
  }
}
