# Datafeed

Polymarket REST candle datafeed and charts (no live Chainlink RTDS).

## What it does

- **Disconnects Chainlink RTDS** — no live websocket tick stream
- Pulls **5m / 15m** candles from Polymarket REST (`/api/chainlink-candles`) on an **hourly** schedule (plus a light latest-page refresh every 5 minutes)
- Builds **30m / 1h / 4h / Daily** by aggregating the 5m series
- Stores Polymarket API credentials from Settings (or `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` env)
- Persists candles in SQLite (44,000 max per pair × window)
- Renders candlesticks for BTC, SOL, ETH, HYPE, XRP, DOGE

## Pairs & windows

| Pairs | REST | Aggregated from 5m |
| --- | --- | --- |
| BTC, SOL, ETH, HYPE, XRP, DOGE | 5m, 15m | 30m, 1h, 4h, 1d |

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3847`.

Optional credentials:

```bash
export POLYMARKET_API_KEY=...
export POLYMARKET_API_SECRET=...
export POLYMARKET_API_PASSPHRASE=...
```

Or paste keys in **Settings → API keys** (saved to the server via `POST /api/credentials`).

Force a sync: `POST /api/sync`.

## Deploy on Railway

```bash
railway up --detach
```

Persist SQLite with a volume at `/data` and `DATAFEED_DB=/data/datafeed.sqlite`.

**Live:** https://datafeed-production-d38d.up.railway.app

## Data sources

- `https://polymarket.com/api/chainlink-candles` — 5m/15m Polymarket candle REST
- `https://gamma-api.polymarket.com` — market metadata
- **Not used:** `wss://ws-live-data.polymarket.com` (Chainlink RTDS disconnected)
