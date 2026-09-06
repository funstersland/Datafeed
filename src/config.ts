/** Supported Polymarket crypto pairs and chart windows for Datafeed. */

export const PAIRS = ["BTC", "SOL", "ETH", "HYPE", "XRP", "DOGE"] as const;
export type Pair = (typeof PAIRS)[number];

export const WINDOWS = ["5m", "15m", "1h", "1d"] as const;
export type Window = (typeof WINDOWS)[number];

/** Max closed+open candles retained per (pair, window). Oldest rows are pruned. */
export const MAX_CANDLES_PER_SERIES = 44_000;

/** Polymarket 5m/15m crypto up/down markets settle on Chainlink TWAP 60s. */
export const TWAP_LOOKBACK_SECONDS = 60;

export const WINDOW_SECONDS: Record<Window, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
};

/** Polymarket API / slug symbols. */
export const PAIR_META: Record<
  Pair,
  {
    symbol: string;
    rtdsSymbol: string;
    slugAsset: string;
    displayName: string;
  }
> = {
  BTC: {
    symbol: "BTC",
    rtdsSymbol: "btc/usd",
    slugAsset: "btc",
    displayName: "Bitcoin",
  },
  ETH: {
    symbol: "ETH",
    rtdsSymbol: "eth/usd",
    slugAsset: "eth",
    displayName: "Ethereum",
  },
  SOL: {
    symbol: "SOL",
    rtdsSymbol: "sol/usd",
    slugAsset: "sol",
    displayName: "Solana",
  },
  XRP: {
    symbol: "XRP",
    rtdsSymbol: "xrp/usd",
    slugAsset: "xrp",
    displayName: "XRP",
  },
  DOGE: {
    symbol: "DOGE",
    rtdsSymbol: "doge/usd",
    slugAsset: "doge",
    displayName: "Dogecoin",
  },
  HYPE: {
    symbol: "HYPE",
    rtdsSymbol: "hype/usd",
    slugAsset: "hype",
    displayName: "Hyperliquid",
  },
};

export const POLYMARKET = {
  gamma: "https://gamma-api.polymarket.com",
  site: "https://polymarket.com",
  rtds: "wss://ws-live-data.polymarket.com",
  twapTopic: "crypto_prices_twap_sixty",
} as const;

export const DB_PATH = process.env.DATAFEED_DB ?? "data/datafeed.sqlite";
export const PORT = Number(process.env.PORT ?? 3847);
/** Railway and containers require 0.0.0.0; local agent browser can use :: */
export const HOST = process.env.HOST ?? "0.0.0.0";
