# Datafeed

Polymarket-only TWAP candle datafeed and live charts.

## What it does

- Streams **Chainlink TWAP 60s** from Polymarket RTDS (`crypto_prices_twap_sixty`)
- Seeds **5m / 15m** candles from Polymarket `/api/chainlink-candles` (TWAP-enabled)
- Builds **1h / Daily** candles from the same TWAP series (Polymarket does not publish those chart intervals)
- Persists every TWAP tick and candles in SQLite
- Keeps **44,000 candles max per pair × window** (oldest pruned when exceeded)
- Renders simple green/red candlesticks
- Discovers each market’s Polymarket **resolution source** for BTC, SOL, ETH, HYPE, XRP, DOGE across 5M / 15M / 1H / Daily

## Pairs & windows

| Pairs | Windows |
| --- | --- |
| BTC, SOL, ETH, HYPE, XRP, DOGE | 5m, 15m, 1h, 1d |

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:8787`.

## Data sources (Polymarket only)

- `wss://ws-live-data.polymarket.com` — live TWAP
- `https://polymarket.com/api/chainlink-candles` — historical 5m/15m TWAP candles
- `https://polymarket.com/api/crypto/price-history` — TWAP path history for market windows
- `https://gamma-api.polymarket.com` — market metadata / resolution sources

No mock data. No third-party price feeds.
