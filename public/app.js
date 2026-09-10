/* global LightweightCharts from CDN */
/* eslint-disable no-undef */

const state = {
  page: "crypto",
  pair: "BTC",
  window: "5m",
  pnlPair: "BTC",
  pnlWindow: "5m",
  seriesCounts: {},
  meta: [],
  chart: null,
  series: null,
  chartCandles: [],
  srLines: [],
  srZones: [],
  srOverlay: null,
  showSr: false,
  settings: null,
};

const SETTINGS_KEY = "datafeed.settings.v1";

const DEFAULT_SETTINGS = {
  apiKey: "",
  apiSecret: "",
  apiPassphrase: "",
  cryptoFeed: "polymarket-rest",
  cryptoFeedUrl: "",
  forexFeed: "none",
  forexFeedUrl: "",
};

const MAX_PNL_ROWS = 250;
const HARD_CANDLE_CAP = 44000;

function $(id) {
  return document.getElementById(id);
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

const POLYMARKET_TZ = "America/New_York";

/**
 * Lightweight Charts treats bar times as UTC for axis labels.
 * Shift the unix second so the printed clock matches Polymarket ET
 * (e.g. 12:45 UTC → shows as 8:45, same as "8:45AM ET" markets).
 */
function utcSecToEtChartTime(utcSec) {
  const d = new Date(Number(utcSec) * 1000);
  if (!Number.isFinite(d.getTime())) return utcSec;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: POLYMARKET_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return Math.floor(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second),
    ) / 1000,
  );
}

function formatEtLabel(msOrSec, { withDate = false } = {}) {
  const ms = Number(msOrSec) > 1e12 ? Number(msOrSec) : Number(msOrSec) * 1000;
  if (!Number.isFinite(ms)) return "—";
  const opts = {
    timeZone: POLYMARKET_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (withDate) {
    opts.month = "short";
    opts.day = "numeric";
  }
  return `${new Intl.DateTimeFormat("en-US", opts).format(new Date(ms))} ET`;
}

function toChartCandle(row) {
  const utcSec = Math.floor(Number(row.openTimeMs) / 1000);
  return {
    time: utcSecToEtChartTime(utcSec),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  };
}

function initChart() {
  const el = $("chart");
  state.srOverlay = $("chart-sr-overlay");
  state.chart = LightweightCharts.createChart(el, {
    layout: {
      background: { color: "transparent" },
      textColor: "#8fa396",
      fontFamily: "'IBM Plex Mono', monospace",
    },
    grid: {
      vertLines: { color: "rgba(232,240,234,0.06)" },
      horzLines: { color: "rgba(232,240,234,0.06)" },
    },
    rightPriceScale: { borderColor: "rgba(232,240,234,0.12)" },
    timeScale: {
      borderColor: "rgba(232,240,234,0.12)",
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    width: el.clientWidth,
    height: el.clientHeight,
  });

  state.series = state.chart.addCandlestickSeries({
    upColor: "#17c964",
    downColor: "#f31260",
    borderUpColor: "#17c964",
    borderDownColor: "#f31260",
    wickUpColor: "#17c964",
    wickDownColor: "#f31260",
  });

  const redrawSr = () => drawSupportResistanceOverlay();
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(redrawSr);
  state.chart.timeScale().subscribeVisibleTimeRangeChange(redrawSr);
  state.series.priceScale().subscribePriceScaleSizeChange?.(redrawSr);

  window.addEventListener("resize", () => {
    state.chart.applyOptions({
      width: el.clientWidth,
      height: el.clientHeight,
    });
    drawSupportResistanceOverlay();
  });
}

function updateMetaCopy() {
  $("series-title").textContent = `${state.pair} · ${state.window.toUpperCase()}`;
  const row = state.meta.find(
    (m) => m.pair === state.pair && m.window === state.window,
  );
  if (!row) {
    $("resolution").textContent = "Resolution source unavailable";
    return;
  }
  const twap = row.twapEnabled
    ? `TWAP ${row.twapLookbackSeconds ?? 60}s`
    : "market resolution (chart still TWAP-built)";
  $("resolution").textContent = [
    row.resolutionSource || "resolution source pending",
    row.marketSlug ? `market: ${row.marketSlug}` : null,
    twap,
    "chart times ET",
  ]
    .filter(Boolean)
    .join(" · ");
}

function updateOhlc(candle) {
  if (!candle) {
    $("ohlc").textContent = "";
    return;
  }
  const color = Number(candle.close) >= Number(candle.open) ? "#17c964" : "#f31260";
  $("ohlc").innerHTML = [
    `<span style="color:${color}">O ${formatPrice(candle.open)}</span>`,
    `H ${formatPrice(candle.high)}`,
    `L ${formatPrice(candle.low)}`,
    `<span style="color:${color}">C ${formatPrice(candle.close)}</span>`,
  ].join("\n");
}

async function loadSeries() {
  updateMetaCopy();
  const res = await fetch(
    `/api/candles/${state.pair}/${state.window}?limit=1500`,
  );
  const data = await res.json();
  const candles = (data.candles || []).map(toChartCandle);
  state.chartCandles = candles;
  state.series.setData(candles);
  if (data.candles?.length) updateOhlc(data.candles[data.candles.length - 1]);
  state.chart.timeScale().fitContent();
  refreshSupportResistance();
}

/**
 * Swing high/low pivots → clustered support/resistance zones.
 * Each level: { price, top, bottom, touches }.
 */
function findSupportResistanceLevels(
  candles,
  { pivot = 3, maxLevels = 2, clusterPct = 0.0045 } = {},
) {
  if (!candles?.length || candles.length < pivot * 2 + 1) {
    return { support: [], resistance: [] };
  }

  const highs = [];
  const lows = [];
  for (let i = pivot; i < candles.length - pivot; i += 1) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    if (![h, l].every(Number.isFinite)) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= pivot; j += 1) {
      if (Number(candles[i - j].high) >= h || Number(candles[i + j].high) >= h) {
        isHigh = false;
      }
      if (Number(candles[i - j].low) <= l || Number(candles[i + j].low) <= l) {
        isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(h);
    if (isLow) lows.push(l);
  }

  const lastClose = Number(candles[candles.length - 1].close);
  const clusterTol =
    Number.isFinite(lastClose) && lastClose > 0
      ? lastClose * clusterPct
      : 0;
  // Minimum painted band height (~0.28% of price), closer to the reference zones.
  const minHalfBand =
    Number.isFinite(lastClose) && lastClose > 0 ? lastClose * 0.0028 : 0;

  const clusterLevels = (prices, prefer) => {
    if (!prices.length) return [];
    const sorted = [...prices].sort((a, b) => a - b);
    const clusters = [];
    let bucket = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      const p = sorted[i];
      const center = bucket.reduce((s, x) => s + x, 0) / bucket.length;
      if (Math.abs(p - center) <= clusterTol) {
        bucket.push(p);
      } else {
        clusters.push(bucket);
        bucket = [p];
      }
    }
    clusters.push(bucket);

    return clusters
      .map((bucketPrices) => {
        const min = Math.min(...bucketPrices);
        const max = Math.max(...bucketPrices);
        const avg =
          bucketPrices.reduce((s, x) => s + x, 0) / bucketPrices.length;
        const half = Math.max((max - min) / 2, minHalfBand);
        return {
          price: avg,
          top: avg + half,
          bottom: avg - half,
          touches: bucketPrices.length,
        };
      })
      .sort((a, b) => {
        if (b.touches !== a.touches) return b.touches - a.touches;
        return (
          Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose)
        );
      })
      .filter((lvl) =>
        prefer === "below" ? lvl.price <= lastClose : lvl.price >= lastClose,
      )
      .slice(0, maxLevels);
  };

  let support = clusterLevels(lows, "below");
  let resistance = clusterLevels(highs, "above");

  // Always try to keep at least one support/resistance near price (reference style).
  if (!support.length && lows.length) {
    const nearest = [...lows]
      .sort((a, b) => Math.abs(a - lastClose) - Math.abs(b - lastClose))
      .filter((p) => p <= lastClose * 1.002)
      .slice(0, maxLevels);
    support = nearest.map((price) => ({
      price,
      top: price + minHalfBand,
      bottom: price - minHalfBand,
      touches: 1,
    }));
  }
  if (!resistance.length && highs.length) {
    const nearest = [...highs]
      .sort((a, b) => Math.abs(a - lastClose) - Math.abs(b - lastClose))
      .filter((p) => p >= lastClose * 0.998)
      .slice(0, maxLevels);
    resistance = nearest.map((price) => ({
      price,
      top: price + minHalfBand,
      bottom: price - minHalfBand,
      touches: 1,
    }));
  }

  // Prefer the nearest visible-ish level of each type (reference shows one S + one R).
  const chartLow = Math.min(...candles.map((c) => Number(c.low)).filter(Number.isFinite));
  const chartHigh = Math.max(...candles.map((c) => Number(c.high)).filter(Number.isFinite));
  const inView = (lvl) =>
    Number.isFinite(chartLow) &&
    Number.isFinite(chartHigh) &&
    lvl.price >= chartLow &&
    lvl.price <= chartHigh;

  const nearestOf = (levels) => {
    const preferred = levels.filter(inView);
    const pool = preferred.length ? preferred : levels;
    return [...pool]
      .sort(
        (a, b) =>
          Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose),
      )
      .slice(0, 1);
  };

  return {
    support: nearestOf(support),
    resistance: nearestOf(resistance),
  };
}

function clearSupportResistanceLines() {
  if (state.series && state.srLines?.length) {
    for (const line of state.srLines) {
      try {
        state.series.removePriceLine(line);
      } catch {
        // line may already be gone after series reset
      }
    }
  }
  state.srLines = [];
  state.srZones = [];
  const canvas = state.srOverlay || $("chart-sr-overlay");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function formatSrLabelPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) return String(Math.round(n));
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

function drawSupportResistanceOverlay() {
  const canvas = state.srOverlay || $("chart-sr-overlay");
  const wrap = canvas?.parentElement;
  if (!canvas || !wrap || !state.series) return;

  const rect = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!state.showSr || !state.srZones.length) return;

  // Leave room for the right price scale (~68px typical).
  const rightPad = 72;
  const drawWidth = Math.max(0, width - rightPad);

  for (const zone of state.srZones) {
    const yTop = state.series.priceToCoordinate(zone.top);
    const yBot = state.series.priceToCoordinate(zone.bottom);
    const yMid = state.series.priceToCoordinate(zone.price);
    if (yTop == null || yBot == null || yMid == null) continue;

    const top = Math.min(yTop, yBot);
    const bot = Math.max(yTop, yBot);
    const bandH = Math.max(bot - top, 8);
    const isSupport = zone.kind === "support";
    const stroke = isSupport ? "rgba(23, 201, 100, 0.95)" : "rgba(243, 18, 96, 0.95)";
    const fill = isSupport ? "rgba(23, 201, 100, 0.16)" : "rgba(243, 18, 96, 0.16)";

    ctx.fillStyle = fill;
    ctx.fillRect(0, top, drawWidth, bandH);

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(0, yMid);
    ctx.lineTo(drawWidth, yMid);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `${isSupport ? "S" : "R"} ${formatSrLabelPrice(zone.price)}`;
    ctx.font = "600 12px 'IBM Plex Mono', monospace";
    ctx.fillStyle = stroke;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(label, drawWidth - 8, yMid);
  }
}

function refreshSupportResistance() {
  clearSupportResistanceLines();
  if (!state.showSr || !state.series || !state.chartCandles.length) {
    drawSupportResistanceOverlay();
    return;
  }

  const { support, resistance } = findSupportResistanceLevels(
    state.chartCandles,
  );

  state.srZones = [
    ...support.map((z) => ({ ...z, kind: "support" })),
    ...resistance.map((z) => ({ ...z, kind: "resistance" })),
  ];

  for (const zone of state.srZones) {
    const isSupport = zone.kind === "support";
    state.srLines.push(
      state.series.createPriceLine({
        price: zone.price,
        color: isSupport ? "#17c964" : "#f31260",
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${isSupport ? "S" : "R"} ${formatSrLabelPrice(zone.price)}`,
      }),
    );
  }

  drawSupportResistanceOverlay();
}

function downloadChartData(format) {
  const url = `/api/candles/${state.pair}/${state.window}/download?format=${format}&limit=44000`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

/** Doji: small body vs high-low range (wicks dominate). */
function isDoji(candle, { maxBodyRatio = 0.25 } = {}) {
  const open = Number(candle.open);
  const close = Number(candle.close);
  const high = Number(candle.high);
  const low = Number(candle.low);
  if (![open, close, high, low].every(Number.isFinite)) return false;
  const body = Math.abs(close - open);
  const range = high - low;
  if (range <= 1e-12) return body <= 1e-12;
  return body / range <= maxBodyRatio;
}

function isRedDoji(candle) {
  return candleColor(candle) === "red" && isDoji(candle);
}

/** Net (close−open) over the lookback candles ending just before index. */
function netCandlePull(candles, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  let sum = 0;
  for (let i = start; i < endIdx; i += 1) {
    sum += Number(candles[i].close) - Number(candles[i].open);
  }
  return sum;
}

function formatMoney(value, { signed = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function getPnlSeriesMax() {
  const key = `${state.pnlPair}|${state.pnlWindow}`;
  const n = Number(state.seriesCounts[key]);
  if (Number.isFinite(n) && n > 0) return Math.min(HARD_CANDLE_CAP, Math.floor(n));
  return null;
}

function applySeriesCounts(stats) {
  const map = {};
  for (const row of stats?.bySeries || []) {
    map[`${row.pair}|${row.window}`] = Number(row.count) || 0;
  }
  state.seriesCounts = map;
}

function updatePnlSeriesHint() {
  const el = $("pnl-series-hint");
  if (!el) return;
  const max = getPnlSeriesMax();
  el.textContent = max != null
    ? `Series: ${state.pnlPair} · ${state.pnlWindow.toUpperCase()} · ${max.toLocaleString()} candles available`
    : `Series: ${state.pnlPair} · ${state.pnlWindow.toUpperCase()}`;
}

/**
 * Wire Candles used to the selected pair/window series max.
 * Placeholder shows "max N"; max attribute and Max button use the same N.
 */
function updatePnlCandleLimitField({ fillMax = false } = {}) {
  const input = $("pnl-limit");
  const maxBtn = $("pnl-limit-max");
  if (!input) return;

  const seriesMax = getPnlSeriesMax();
  const effectiveMax = seriesMax != null ? Math.max(2, seriesMax) : HARD_CANDLE_CAP;
  input.min = "2";
  input.max = String(effectiveMax);
  input.placeholder = seriesMax != null ? `max ${seriesMax}` : "max —";
  input.title =
    seriesMax != null
      ? `Candles available for ${state.pnlPair} ${state.pnlWindow}: ${seriesMax}. Leave blank or click Max to use all.`
      : "Candles available for this series (loading…)";

  if (maxBtn) {
    maxBtn.disabled = seriesMax == null || seriesMax < 2;
    maxBtn.title =
      seriesMax != null
        ? `Use all ${seriesMax} candles for ${state.pnlPair} ${state.pnlWindow}`
        : "Series candle count unavailable";
  }

  const raw = input.value.trim();
  const current = raw === "" ? null : Number(raw);
  if (fillMax && seriesMax != null) {
    input.value = String(seriesMax);
  } else if (current != null && Number.isFinite(current) && current > effectiveMax) {
    input.value = String(effectiveMax);
  }

  updatePnlSeriesHint();
}

function resolvePnlCandleLimit() {
  const seriesMax = getPnlSeriesMax();
  const hardMax = seriesMax != null ? Math.max(2, seriesMax) : HARD_CANDLE_CAP;
  const raw = String($("pnl-limit").value || "").trim();
  if (raw === "") return hardMax;
  const n = Number(raw);
  if (!Number.isFinite(n)) return hardMax;
  return Math.min(hardMax, Math.max(2, Math.floor(n)));
}

function updatePnlExample() {
  const el = $("pnl-example");
  if (!el) return;
  const lot = Number($("pnl-stake").value);
  const mult = Number($("pnl-payout").value);
  const capital = Number($("pnl-capital").value);
  if (!Number.isFinite(lot) || lot <= 0 || !Number.isFinite(mult) || mult < 1) {
    el.textContent = "Set lot and payout multiplier (use 2 for double-money wins).";
    el.classList.remove("warn");
    return;
  }
  const payout = lot * mult;
  const net = payout - lot;
  const afterInvest = Number.isFinite(capital) ? capital - lot : null;
  const afterWin =
    afterInvest != null ? afterInvest + payout : null;
  el.textContent = [
    `Multiplier ${formatMoney(mult, { signed: false })}× — not dollars.`,
    `Example base lot: invest ${formatMoney(lot, { signed: false })} → win returns ${formatMoney(payout, { signed: false })} total (net ${formatMoney(net)}).`,
    afterWin != null
      ? `Capital path: ${formatMoney(capital, { signed: false })} → ${formatMoney(afterInvest, { signed: false })} → ${formatMoney(afterWin, { signed: false })}.`
      : null,
    mult > 5
      ? `Warning: ${formatMoney(mult, { signed: false })}× is very high — for 2× payout enter 2 (a $40 stake would return $80, not $800).`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  el.classList.toggle("warn", mult > 5);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

const PAKISTAN_TZ = "Asia/Karachi";

function formatTradeTime(ms) {
  return formatEtLabel(ms, { withDate: true });
}

/** Hour of day 0–23 in Pakistan Standard Time (Asia/Karachi). */
function pakistanHour(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PAKISTAN_TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

/** e.g. 0 → 12Am, 1 → 1Am, 13 → 1Pm */
function formatHourAmPm(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const suffix = h < 12 ? "Am" : "Pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/**
 * Bucket real (non-skipped) trades by Pakistan clock hour.
 * Returns all 24 hours plus top profit / top loss hours.
 */
function summarizePakistanHours(trades, { topN = 3 } = {}) {
  const byHour = [];
  for (let h = 0; h < 24; h += 1) {
    byHour.push({
      hour: h,
      label: formatHourAmPm(h),
      pnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
    });
  }

  for (const t of trades || []) {
    if (t.skipped) continue;
    const hour = pakistanHour(t.openTimeMs);
    const bucket = byHour[hour];
    if (!bucket) continue;
    bucket.pnl += Number(t.pnl) || 0;
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    else bucket.losses += 1;
  }

  const active = byHour.filter((b) => b.trades > 0);
  const byPnlDesc = [...active].sort((a, b) => b.pnl - a.pnl || a.hour - b.hour);
  const byPnlAsc = [...active].sort((a, b) => a.pnl - b.pnl || a.hour - b.hour);

  return {
    byHour,
    topProfitHours: byPnlDesc.filter((b) => b.pnl > 0).slice(0, topN),
    topLossHours: byPnlAsc.filter((b) => b.pnl < 0).slice(0, topN),
  };
}

/**
 * Color-follow strategy with optional martingale, continuation-3 entry,
 * 5-loss half-hour break, configurable martingale reset+break (N losses / M minutes),
 * martingale cap (max 3 losses / no 4th double),
 * RedDogi (net upside pull → red doji → bet next red once → leave),
 * Red-2 entry (after 1 red → bet next red → wait for green → repeat),
 * and Green-2 entry (after 1 green → bet next green → wait for red → repeat).
 *
 * Continuation entry: after 3 losses → wait for 2 same colors, trade the 3rd.
 * Half-hour break: after 5 losses → skip 30 minutes of candle time, then join
 * next continuation; another loss after resume → another half-hour break.
 * Martingale reset+break: after N consecutive losses in a multi-color (junk)
 * run, reset stake to base and skip M minutes — never more than N losses in a row.
 * Martingale cap: after 3rd loss reset stake to base (no 8×); any win resets stake.
 * RedDogi: when the last few candles are net upside (some reds OK), a red doji
 * is the signal (no bet); bet the next candle red once, then leave and repeat.
 * Red-2 / Green-2: after one signal candle of that color, bet the next is the
 * same color; then wait for the opposite color before the next signal;
 * martingale doubles after every loss. If both are checked, Red-2 wins.
 * Skipped rounds: Predict=skipped, Actual=real candle color.
 */
function runColorFollowStrategy(
  candles,
  {
    baseStake,
    payout,
    martingale,
    capital,
    candlesRequested,
    seriesTotal,
    cont3Entry = false,
    martingaleCap3 = false,
    halfHourBreak5 = false,
    martingaleResetBreak = false,
    resetBreakLosses = 5,
    resetBreakMinutes = 30,
    redDogi = false,
    red2Entry = false,
    green2Entry = false,
  },
) {
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const resetLossThreshold = Math.max(
    1,
    Math.floor(Number(resetBreakLosses) || 5),
  );
  const resetBreakMs =
    Math.max(1, Math.floor(Number(resetBreakMinutes) || 30)) * 60 * 1000;
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const requested = Number.isFinite(candlesRequested)
    ? candlesRequested
    : candles.length;
  const fetched = candles.length;
  const notEnoughCandleData = usable.length < 2 || fetched < requested;
  const trades = [];
  let stake = baseStake;
  const startCapital = Number.isFinite(capital) ? capital : baseStake;
  let balance = startCapital;
  let peak = startCapital;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let skips = 0;
  let unrecoveredLoss = 0;
  let maxStake = baseStake;
  let currentStreakColor = null;
  let currentStreakLen = 0;
  let longestStreak = 0;
  let liquidated = false;
  let liquidatedReason = null;
  let stopReason = "completed";
  let consecutiveLosses = 0;
  // null | "wait_half_hour" | "wait_reset_break" | "wait_two_same" | "wait_third"
  let skipMode = null;
  let streakColor = null;
  let breakUntilMs = 0;
  let resumeArmed = false;
  let halfHourArmed = false;
  let pendingJoinFromHalfHour = false;
  const useCont3 = Boolean(cont3Entry);
  const useCap3 = Boolean(martingaleCap3);
  const useHalf5 = Boolean(halfHourBreak5);
  const useResetBreak = Boolean(martingaleResetBreak);
  const useRed2 = Boolean(red2Entry);
  const useGreen2 = Boolean(green2Entry) && !useRed2;
  const useColor2 = useRed2 || useGreen2;
  const color2Signal = useRed2 ? "red" : useGreen2 ? "green" : null;
  const color2Opposite =
    color2Signal === "red" ? "green" : color2Signal === "green" ? "red" : null;
  const useRedDogi = Boolean(redDogi) && !useColor2;
  const useContinuationJoin = useCont3 || useHalf5;
  // hunt | bet_once — only used when useRedDogi
  let dogiPhase = "hunt";
  const DOGI_LOOKBACK = 5;
  // wait_signal | bet_signal | wait_opposite — only used when useColor2
  // If the first candle already matches the signal color, arm bet on candle 2.
  let color2Phase =
    useColor2 && candleColor(usable[0]) === color2Signal
      ? "bet_signal"
      : "wait_signal";

  const emptyResult = (statusMessage) => ({
    trades: [],
    candlesRequested: requested,
    candlesFetched: fetched,
    candlesAvailable: usable.length,
    candlesUsed: usable.length,
    seriesTotal: Number.isFinite(seriesTotal) ? seriesTotal : null,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    skips: 0,
    winRate: 0,
    capital: startCapital,
    endingBalance: startCapital,
    netPnl: 0,
    maxDrawdown: 0,
    maxStake: baseStake,
    longestStreak: 0,
    martingale,
    cont3Entry: useCont3,
    martingaleCap3: useCap3,
    halfHourBreak5: useHalf5,
    martingaleResetBreak: useResetBreak,
    resetBreakLosses: resetLossThreshold,
    resetBreakMinutes: resetBreakMs / 60_000,
    redDogi: useRedDogi,
    red2Entry: useRed2,
    green2Entry: useGreen2,
    baseStake,
    payout,
    liquidated: false,
    liquidatedReason: null,
    notEnoughCandleData: true,
    stopReason: "not_enough_candle_data",
    statusMessage,
  });

  if (usable.length < 2) {
    const haveLabel = Number.isFinite(seriesTotal)
      ? `${seriesTotal} in this chart series`
      : `${fetched} fetched`;
    return emptyResult(
      `Not Enough Candle Data — need at least 2 closed candles, have ${usable.length} (${haveLabel})`,
    );
  }

  const pushSkip = (cur) => {
    skips += 1;
    trades.push({
      index: trades.length + 1,
      openTimeMs: cur.openTimeMs,
      predicted: "skipped",
      actual: candleColor(cur),
      stake: 0,
      won: null,
      skipped: true,
      payoutReturned: 0,
      pnl: 0,
      balance,
      liquidated: false,
    });
  };

  const enterWaitTwoSame = () => {
    skipMode = "wait_two_same";
    streakColor = null;
    consecutiveLosses = 0;
  };

  const enterHalfHourBreak = (cur) => {
    breakUntilMs = Number(cur.openTimeMs) + HALF_HOUR_MS;
    skipMode = "wait_half_hour";
    streakColor = null;
    consecutiveLosses = 0;
    halfHourArmed = false;
    pendingJoinFromHalfHour = false;
    resumeArmed = false;
  };

  const enterResetBreak = (cur) => {
    breakUntilMs = Number(cur.openTimeMs) + resetBreakMs;
    skipMode = "wait_reset_break";
    streakColor = null;
    consecutiveLosses = 0;
    unrecoveredLoss = 0;
    stake = baseStake;
    resumeArmed = false;
    halfHourArmed = false;
    pendingJoinFromHalfHour = false;
  };

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const actual = candleColor(cur);

    if (currentStreakColor === actual) {
      currentStreakLen += 1;
    } else {
      currentStreakColor = actual;
      currentStreakLen = 1;
    }
    longestStreak = Math.max(longestStreak, currentStreakLen);

    if (useColor2) {
      if (color2Phase === "wait_signal") {
        pushSkip(cur);
        if (actual === color2Signal) color2Phase = "bet_signal";
        continue;
      }
      if (color2Phase === "wait_opposite") {
        pushSkip(cur);
        if (actual === color2Opposite) color2Phase = "wait_signal";
        continue;
      }
      // color2Phase === "bet_signal" → place bet predicting color2Signal
    } else if (useRedDogi) {
      if (dogiPhase === "hunt") {
        pushSkip(cur);
        // Red doji after a net-upside pull over the last few candles → arm one bet.
        if (
          i >= DOGI_LOOKBACK &&
          isRedDoji(cur) &&
          netCandlePull(usable, i, DOGI_LOOKBACK) > 0
        ) {
          dogiPhase = "bet_once";
        }
        continue;
      }
      // dogiPhase === "bet_once" → place a single bet predicting red
    } else {
      if (useResetBreak && skipMode === "wait_reset_break") {
        pushSkip(cur);
        if (Number(cur.openTimeMs) >= breakUntilMs) {
          skipMode = null;
          stake = baseStake;
          unrecoveredLoss = 0;
          consecutiveLosses = 0;
        }
        continue;
      }

      if (useHalf5 && skipMode === "wait_half_hour") {
        pushSkip(cur);
        if (Number(cur.openTimeMs) >= breakUntilMs) {
          // Half hour elapsed — join next continuation.
          skipMode = "wait_two_same";
          streakColor = null;
          pendingJoinFromHalfHour = true;
        }
        continue;
      }

      if (useContinuationJoin && skipMode === "wait_two_same") {
        pushSkip(cur);
        if (candleColor(prev) === actual) {
          streakColor = actual;
          skipMode = "wait_third";
        }
        continue;
      }

      if (useContinuationJoin && skipMode === "wait_third") {
        skipMode = null;
        streakColor = null;
        if (pendingJoinFromHalfHour) {
          halfHourArmed = true;
          pendingJoinFromHalfHour = false;
        } else {
          resumeArmed = true;
        }
      }
    }

    const predicted = useColor2
      ? color2Signal
      : useRedDogi
        ? "red"
        : candleColor(prev);
    const tradeStake = stake;
    if (tradeStake > balance + 1e-9) {
      liquidated = true;
      liquidatedReason = `Account liquidated — lot ${tradeStake.toFixed(2)} exceeds balance ${balance.toFixed(2)}`;
      stopReason = "liquidated";
      break;
    }

    balance -= tradeStake;
    let payoutReturned = 0;
    let pnl = 0;
    const won = predicted === actual;

    if (won) {
      payoutReturned = tradeStake * payout;
      balance += payoutReturned;
      pnl = payoutReturned - tradeStake;
      wins += 1;
      consecutiveLosses = 0;
      if (martingale) {
        if (useCap3) {
          unrecoveredLoss = 0;
          stake = baseStake;
          resumeArmed = false;
          halfHourArmed = false;
        } else {
          unrecoveredLoss = Math.max(0, unrecoveredLoss - pnl);
          if (unrecoveredLoss <= 1e-9) {
            unrecoveredLoss = 0;
            stake = baseStake;
            resumeArmed = false;
            halfHourArmed = false;
          }
        }
      } else {
        resumeArmed = false;
        halfHourArmed = false;
      }
    } else {
      payoutReturned = 0;
      pnl = -tradeStake;
      losses += 1;
      consecutiveLosses += 1;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        if (useCap3 && consecutiveLosses >= 3) {
          stake = baseStake;
          unrecoveredLoss = 0;
          // keep consecutiveLosses so half-hour filter can still reach 5
        } else if (useResetBreak && consecutiveLosses >= resetLossThreshold) {
          // Cap this junk run: next stake is base after the break, not another double.
          stake = baseStake;
        } else {
          stake = tradeStake * 2;
        }
      }
    }

    if (balance < -1e-9) {
      liquidated = true;
      liquidatedReason = "Account liquidated — balance went negative";
      stopReason = "liquidated";
    }

    maxStake = Math.max(maxStake, tradeStake);
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);

    trades.push({
      index: trades.length + 1,
      openTimeMs: cur.openTimeMs,
      predicted,
      actual,
      stake: tradeStake,
      won,
      skipped: false,
      payoutReturned,
      pnl,
      balance,
      liquidated: liquidated && balance < -1e-9,
    });

    if (liquidated) break;

    if (useColor2) {
      // Win (signal color) → wait for opposite. Loss on opposite already unlocks.
      color2Phase =
        actual === color2Opposite ? "wait_signal" : "wait_opposite";
      continue;
    }

    if (useRedDogi) {
      // One bet only — leave the market and hunt the next upside→red-doji setup.
      dogiPhase = "hunt";
      continue;
    }

    if (!won) {
      // After N consecutive losses in multi-color junk → reset to base + M minute break.
      if (useResetBreak && consecutiveLosses >= resetLossThreshold) {
        enterResetBreak(cur);
        continue;
      }
      if (useHalf5 && (consecutiveLosses >= 5 || halfHourArmed)) {
        // 5 consecutive losses, or the next loss after rejoining ("6th") → 30m break.
        enterHalfHourBreak(cur);
        continue;
      }
      if (useCont3) {
        if (
          consecutiveLosses >= 3 ||
          (resumeArmed && (martingale ? unrecoveredLoss > 1e-9 : true))
        ) {
          enterWaitTwoSame();
        }
      }
    }
  }

  const candlesRemaining = Math.max(0, usable.length - (trades.length + 1));
  if (
    !liquidated &&
    balance + 1e-9 < baseStake &&
    candlesRemaining > 0
  ) {
    liquidated = true;
    liquidatedReason = "Account liquidated — capital exhausted";
    stopReason = "liquidated";
  }

  let statusMessage = null;
  if (stopReason === "liquidated") {
    statusMessage = `${liquidatedReason} (${candlesRemaining} candle${candlesRemaining === 1 ? "" : "s"} still unused — not a data shortage)`;
  } else if (notEnoughCandleData) {
    const seriesPart = Number.isFinite(seriesTotal)
      ? `, series total ${seriesTotal}`
      : "";
    statusMessage = `Not Enough Candle Data — fetched ${fetched} for this chart, requested ${requested}${seriesPart}`;
    stopReason = "not_enough_candle_data";
  }

  const realTrades = wins + losses;
  const hourSummary = summarizePakistanHours(trades);
  return {
    trades,
    candlesRequested: requested,
    candlesFetched: fetched,
    candlesAvailable: usable.length,
    candlesUsed: usable.length,
    candlesRemaining,
    seriesTotal: Number.isFinite(seriesTotal) ? seriesTotal : null,
    tradeCount: realTrades,
    wins,
    losses,
    skips,
    winRate: realTrades ? wins / realTrades : 0,
    capital: startCapital,
    endingBalance: balance,
    netPnl: balance - startCapital,
    maxDrawdown,
    maxStake,
    longestStreak,
    martingale,
    cont3Entry: useCont3,
    martingaleCap3: useCap3,
    halfHourBreak5: useHalf5,
    martingaleResetBreak: useResetBreak,
    resetBreakLosses: resetLossThreshold,
    resetBreakMinutes: resetBreakMs / 60_000,
    redDogi: useRedDogi,
    red2Entry: useRed2,
    green2Entry: useGreen2,
    baseStake,
    payout,
    liquidated,
    liquidatedReason,
    notEnoughCandleData,
    stopReason,
    statusMessage,
    hoursByPakistan: hourSummary.byHour,
    topProfitHours: hourSummary.topProfitHours,
    topLossHours: hourSummary.topLossHours,
  };
}

function renderHourlyPnlGrid(result) {
  const hours = result.hoursByPakistan || [];
  if (!hours.length) return "";

  const topProfitHour = result.topProfitHours?.[0]?.hour;
  const topLossHour = result.topLossHours?.[0]?.hour;

  const cards = hours
    .map((b) => {
      const pnlClass =
        b.pnl > 0 ? "up" : b.pnl < 0 ? "down" : "";
      const mark =
        b.hour === topProfitHour
          ? " top-profit"
          : b.hour === topLossHour
            ? " top-loss"
            : "";
      const wl =
        b.trades > 0 ? `${b.wins}W ${b.losses}L` : "—";
      return `<div class="pnl-hour-card${mark}" title="${b.label} PKT">
        <span class="hour-label">${b.label}</span>
        <span class="hour-pnl ${pnlClass}">${formatMoney(b.pnl)}</span>
        <span class="hour-wl">${wl}</span>
      </div>`;
    })
    .join("");

  return `<div class="pnl-hours-block">
    <div class="pnl-hours-heading">Hourly PnL · Pakistan time</div>
    <div class="pnl-hours-grid">${cards}</div>
  </div>`;
}

function renderPnlSummary(result) {
  const pnlClass = result.netPnl >= 0 ? "up" : "down";
  const rows = [];
  if (result.statusMessage) {
    const statusClass =
      result.stopReason === "not_enough_candle_data" || result.liquidated
        ? "down"
        : "";
    rows.push(["Status", result.statusMessage, statusClass]);
  }
  rows.push(
    ["Series", `${result.pair} · ${String(result.window).toUpperCase()}`, ""],
    ["Net PnL", formatMoney(result.netPnl), pnlClass],
    [
      "Capital → balance",
      `${formatMoney(result.capital, { signed: false })} → ${formatMoney(result.endingBalance, { signed: false })}`,
      result.liquidated ? "down" : "",
    ],
    ["Trades", String(result.tradeCount), ""],
    ["Wins", String(result.wins), "up"],
    ["Losses", String(result.losses), "down"],
    ["Skipped", String(result.skips || 0), ""],
    ["Win rate", formatPct(result.winRate), ""],
    ["Max drawdown", formatMoney(-result.maxDrawdown), "down"],
    ["Max stake", formatMoney(result.maxStake, { signed: false }), ""],
    [
      "Payout multiplier",
      `${formatMoney(result.payout, { signed: false })}×`,
      result.payout > 5 ? "down" : "",
    ],
    ["Longest color streak", String(result.longestStreak), ""],
    [
      "Candles",
      [
        `${result.candlesAvailable} closed used`,
        `${result.candlesFetched} fetched / ${result.candlesRequested} requested`,
        result.seriesTotal != null ? `${result.seriesTotal} in series` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      result.notEnoughCandleData ? "down" : "",
    ],
    [
      "Mode",
      [
        result.martingale ? "Martingale" : "Flat stake",
        result.martingaleCap3 ? "cap@3" : null,
        result.martingaleResetBreak
          ? `reset+break@${result.resetBreakLosses}losses/${result.resetBreakMinutes}m`
          : null,
        result.cont3Entry ? "cont-3 entry" : null,
        result.halfHourBreak5 ? "5-loss 30m break" : null,
        result.redDogi ? "RedDogi" : null,
        result.red2Entry ? "Red-2 entry" : null,
        result.green2Entry ? "Green-2 entry" : null,
      ]
        .filter(Boolean)
        .join(" + "),
      "",
    ],
  );
  $("pnl-summary").innerHTML =
    rows
      .map(
        ([label, value, cls]) =>
          `<div class="pnl-stat"><span class="label">${label}</span><span class="value ${cls}">${value}</span></div>`,
      )
      .join("") + renderHourlyPnlGrid(result);
}

function renderPnlTrades(trades) {
  const table = $("pnl-table");
  const tbody = $("pnl-tbody");
  if (!trades.length) {
    table.hidden = true;
    tbody.innerHTML = "";
    return;
  }
  const slice = trades.slice(-MAX_PNL_ROWS);
  const omitted = trades.length - slice.length;
  tbody.innerHTML = [
    omitted > 0
      ? `<tr><td colspan="9">Showing last ${MAX_PNL_ROWS} of ${trades.length} trades (${omitted} earlier omitted)</td></tr>`
      : "",
    ...slice.map((t) => {
      if (t.skipped) {
        return `<tr class="skip-row">
        <td>${t.index}</td>
        <td>${formatTradeTime(t.openTimeMs)}</td>
        <td class="skip">skipped</td>
        <td class="color-${t.actual}">${t.actual}</td>
        <td class="skip">—</td>
        <td class="skip">skip</td>
        <td class="skip">—</td>
        <td class="skip">0.00</td>
        <td>${formatMoney(t.balance, { signed: false })}</td>
      </tr>`;
      }
      const resultClass = t.won ? "win" : "loss";
      const balClass = t.balance < 0 || t.liquidated ? "loss" : "win";
      return `<tr>
        <td>${t.index}</td>
        <td>${formatTradeTime(t.openTimeMs)}</td>
        <td class="color-${t.predicted}">${t.predicted}</td>
        <td class="color-${t.actual}">${t.actual}</td>
        <td>${formatMoney(t.stake, { signed: false })}</td>
        <td class="${resultClass}">${t.won ? "win" : "loss"}</td>
        <td class="${resultClass}">${formatMoney(t.payoutReturned, { signed: false })}</td>
        <td class="${resultClass}">${formatMoney(t.pnl)}</td>
        <td class="${balClass}">${formatMoney(t.balance, { signed: false })}</td>
      </tr>`;
    }),
  ].join("");
  table.hidden = false;
}

async function calculatePnl() {
  const pair = state.pnlPair;
  const window = state.pnlWindow;
  const baseStake = Number($("pnl-stake").value);
  const payout = Number($("pnl-payout").value);
  const capital = Number($("pnl-capital").value);
  const limit = resolvePnlCandleLimit();
  const martingale = $("pnl-martingale").checked;
  const cont3Entry = $("pnl-cont3-entry").checked;
  const martingaleCap3 = $("pnl-martingale-cap3").checked;
  const halfHourBreak5 = $("pnl-halfhour-5").checked;
  const martingaleResetBreak = Boolean(
    $("pnl-martingale-reset-break")?.checked,
  );
  const resetBreakLosses = Math.max(
    1,
    Math.floor(Number($("pnl-reset-break-losses")?.value) || 5),
  );
  const resetBreakMinutes = Math.max(
    1,
    Math.floor(Number($("pnl-reset-break-minutes")?.value) || 30),
  );
  const redDogi = $("pnl-red-dogi").checked;
  const red2Entry = $("pnl-red2-entry").checked;
  const green2Entry = $("pnl-green2-entry").checked;
  $("pnl-limit").value = String(limit);

  if (
    (cont3Entry ||
      martingaleCap3 ||
      halfHourBreak5 ||
      martingaleResetBreak ||
      red2Entry ||
      green2Entry) &&
    !martingale
  ) {
    $("pnl-martingale").checked = true;
  }

  if (!Number.isFinite(baseStake) || baseStake <= 0) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Base stake (lot) must be &gt; 0</span></div>`;
    return;
  }
  if (!Number.isFinite(payout) || payout < 1) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Payout multiplier must be ≥ 1 (use 2 for double — $40 stake returns $80)</span></div>`;
    return;
  }
  if (payout > 10) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Payout multiplier max is 10×. For 2× wins enter 2 — not 20. ($40 × 2 = $80, not $800)</span></div>`;
    return;
  }
  if (!Number.isFinite(capital) || capital < baseStake) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Capital must cover base stake</span></div>`;
    return;
  }

  $("pnl-run").disabled = true;
  $("pnl-summary").innerHTML =
    `<div class="pnl-stat"><span class="label">Status</span><span class="value">Calculating ${pair} ${window}…</span></div>`;

  try {
    const res = await fetch(
      `/api/candles/${pair}/${window}?limit=${limit}`,
    );
    const data = await res.json();
    const candles = data.candles || [];
    if (candles.length < 2) {
      $("pnl-summary").innerHTML =
        `<div class="pnl-stat"><span class="label">Status</span><span class="value down">Not Enough Candle Data — need at least 2 candles for ${pair} ${window}, have ${candles.length}</span></div>`;
      $("pnl-table").hidden = true;
      return;
    }

    let seriesTotal = null;
    try {
      const stats = await fetch("/api/stats").then((r) => r.json());
      const row = (stats.bySeries || []).find(
        (s) => s.pair === pair && s.window === window,
      );
      if (row) seriesTotal = Number(row.count);
    } catch {
      // optional enrichment
    }

    const result = runColorFollowStrategy(candles, {
      baseStake,
      payout,
      martingale:
        martingale ||
        cont3Entry ||
        martingaleCap3 ||
        halfHourBreak5 ||
        martingaleResetBreak ||
        red2Entry ||
        green2Entry ||
        $("pnl-martingale").checked,
      capital,
      candlesRequested: limit,
      seriesTotal,
      cont3Entry,
      martingaleCap3,
      halfHourBreak5,
      martingaleResetBreak,
      resetBreakLosses,
      resetBreakMinutes,
      redDogi,
      red2Entry,
      green2Entry,
    });
    result.pair = pair;
    result.window = window;
    renderPnlSummary(result);
    renderPnlTrades(result.trades);
  } catch (err) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">${String(err.message || err)}</span></div>`;
  } finally {
    $("pnl-run").disabled = false;
  }
}

function setPage(page) {
  const next = page === "forex" ? "forex" : "crypto";
  state.page = next;

  const cryptoPanel = $("page-crypto");
  const forexPanel = $("page-forex");
  if (cryptoPanel) cryptoPanel.hidden = next !== "crypto";
  if (forexPanel) forexPanel.hidden = next !== "forex";

  document.querySelectorAll(".page-tab[data-page]").forEach((btn) => {
    const active = btn.getAttribute("data-page") === next;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  const tagline = $("page-tagline");
  if (tagline) {
    if (next === "forex") {
      const forex = state.settings?.forexFeed;
      tagline.textContent =
        forex === "custom" && state.settings?.forexFeedUrl
          ? `Custom forex feed · ${state.settings.forexFeedUrl}`
          : "Forex markets — coming online";
    } else {
      applyFeedSettings();
    }
  }

  document.title =
    next === "forex"
      ? "Datafeed — Forex"
      : "Datafeed — Polymarket TWAP";

  if (location.hash.replace(/^#/, "") !== next) {
    history.replaceState(null, "", `#${next}`);
  }

  if (next === "crypto" && state.chart) {
    requestAnimationFrame(() => {
      const el = $("chart");
      if (!el) return;
      state.chart.applyOptions({
        width: el.clientWidth,
        height: el.clientHeight,
      });
      drawSupportResistanceOverlay();
    });
  }
}

function pageFromHash() {
  const hash = location.hash.replace(/^#/, "").toLowerCase();
  return hash === "forex" ? "forex" : "crypto";
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  state.settings = { ...DEFAULT_SETTINGS, ...next };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  return state.settings;
}

function fillSettingsForm(settings) {
  const s = settings || state.settings || DEFAULT_SETTINGS;
  $("settings-api-key").value = s.apiKey || "";
  $("settings-api-secret").value = s.apiSecret || "";
  $("settings-api-passphrase").value = s.apiPassphrase || "";
  $("settings-crypto-feed").value = s.cryptoFeed || "polymarket-twap";
  $("settings-crypto-url").value = s.cryptoFeedUrl || "";
  $("settings-forex-feed").value = s.forexFeed || "none";
  $("settings-forex-url").value = s.forexFeedUrl || "";
}

function readSettingsForm() {
  return {
    apiKey: $("settings-api-key").value.trim(),
    apiSecret: $("settings-api-secret").value.trim(),
    apiPassphrase: $("settings-api-passphrase").value.trim(),
    cryptoFeed: $("settings-crypto-feed").value,
    cryptoFeedUrl: $("settings-crypto-url").value.trim(),
    forexFeed: $("settings-forex-feed").value,
    forexFeedUrl: $("settings-forex-url").value.trim(),
  };
}

function setSettingsTab(tab) {
  const next = ["api", "crypto", "forex"].includes(tab) ? tab : "api";
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    const active = btn.getAttribute("data-settings-tab") === next;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.getAttribute("data-settings-panel") !== next;
  });
}

function openSettings(tab = "api") {
  const modal = $("settings-modal");
  if (!modal) return;
  fillSettingsForm(state.settings);
  setSettingsTab(tab);
  $("settings-saved").textContent = "";
  modal.hidden = false;
  $("settings-open")?.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
}

function closeSettings() {
  const modal = $("settings-modal");
  if (!modal) return;
  modal.hidden = true;
  $("settings-open")?.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function wireSettings() {
  state.settings = loadSettings();

  $("settings-open")?.addEventListener("click", () => openSettings("api"));
  document.querySelectorAll("[data-settings-close]").forEach((el) => {
    el.addEventListener("click", () => closeSettings());
  });
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSettingsTab(btn.getAttribute("data-settings-tab"));
    });
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("settings-modal")?.hidden) closeSettings();
  });

  $("settings-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const next = readSettingsForm();
    saveSettings(next);
    const note = $("settings-saved");
    if (note) note.textContent = "Saving to server…";
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: next.apiKey,
          apiSecret: next.apiSecret,
          apiPassphrase: next.apiPassphrase,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (note) note.textContent = "Saved locally + server";
    } catch (err) {
      console.error(err);
      if (note) note.textContent = "Saved locally (server sync failed)";
    }
    applyFeedSettings();
  });

  applyFeedSettings();
}

function applyFeedSettings() {
  const s = state.settings || DEFAULT_SETTINGS;
  const tag = $("page-tagline");
  if (!tag || state.page !== "crypto") return;
  if (s.cryptoFeed === "custom" && s.cryptoFeedUrl) {
    tag.textContent = `Custom crypto feed · ${s.cryptoFeedUrl}`;
  } else {
    tag.textContent = "Polymarket REST candles · hourly sync · no Chainlink RTDS";
  }
}

function wireControls() {
  wireSettings();
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setPage(btn.getAttribute("data-page"));
    });
  });
  window.addEventListener("hashchange", () => setPage(pageFromHash()));

  document.querySelectorAll("[data-pair]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pair]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.pair = btn.getAttribute("data-pair");
      loadSeries();
    });
  });
  document.querySelectorAll("[data-window]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-window]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.window = btn.getAttribute("data-window");
      loadSeries();
    });
  });
  document.querySelectorAll("[data-pnl-pair]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pnl-pair]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.pnlPair = btn.getAttribute("data-pnl-pair");
      updatePnlCandleLimitField();
    });
  });
  document.querySelectorAll("[data-pnl-window]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pnl-window]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.pnlWindow = btn.getAttribute("data-pnl-window");
      updatePnlCandleLimitField();
    });
  });
  $("download-csv").addEventListener("click", () => downloadChartData("csv"));
  $("download-json").addEventListener("click", () => downloadChartData("json"));
  $("chart-sr").addEventListener("change", () => {
    state.showSr = $("chart-sr").checked;
    refreshSupportResistance();
  });
  $("pnl-run").addEventListener("click", () => calculatePnl());
  $("pnl-cont3-entry").addEventListener("change", () => {
    if ($("pnl-cont3-entry").checked) $("pnl-martingale").checked = true;
  });
  $("pnl-martingale-cap3").addEventListener("change", () => {
    if ($("pnl-martingale-cap3").checked) $("pnl-martingale").checked = true;
  });
  $("pnl-martingale-reset-break")?.addEventListener("change", () => {
    if ($("pnl-martingale-reset-break").checked) {
      $("pnl-martingale").checked = true;
    }
  });
  $("pnl-halfhour-5").addEventListener("change", () => {
    if ($("pnl-halfhour-5").checked) $("pnl-martingale").checked = true;
  });
  $("pnl-red2-entry").addEventListener("change", () => {
    if ($("pnl-red2-entry").checked) $("pnl-martingale").checked = true;
  });
  $("pnl-green2-entry").addEventListener("change", () => {
    if ($("pnl-green2-entry").checked) $("pnl-martingale").checked = true;
  });
  $("pnl-limit-max").addEventListener("click", () => {
    updatePnlCandleLimitField({ fillMax: true });
  });
  $("pnl-limit").addEventListener("change", () => {
    const max = getPnlSeriesMax();
    if (max == null) return;
    const n = Number($("pnl-limit").value);
    if (Number.isFinite(n) && n > max) $("pnl-limit").value = String(max);
    if (Number.isFinite(n) && n < 2) $("pnl-limit").value = "2";
  });
  ["pnl-capital", "pnl-stake", "pnl-payout"].forEach((id) => {
    $(id).addEventListener("input", updatePnlExample);
    $(id).addEventListener("change", updatePnlExample);
  });
  updatePnlCandleLimitField();
  updatePnlExample();
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "status" || msg.type === "hello") {
      $("feed-status").textContent = msg.status || "live";
      if (msg.stats) {
        $("stats").textContent = `${msg.stats.ticks} ticks · ${msg.stats.candles} candles`;
        if (msg.stats.bySeries) {
          applySeriesCounts(msg.stats);
          updatePnlCandleLimitField();
        }
      }
    }
    if (msg.type === "meta") {
      state.meta = msg.meta || [];
      updateMetaCopy();
    }
    if (msg.type === "candle") {
      const c = msg.candle;
      if (c.pair !== state.pair || c.window !== state.window) return;
      const chartCandle = toChartCandle(c);
      state.series.update(chartCandle);
      updateOhlc(c);
      const last = state.chartCandles[state.chartCandles.length - 1];
      if (last && last.time === chartCandle.time) {
        state.chartCandles[state.chartCandles.length - 1] = chartCandle;
      } else if (!last || chartCandle.time > last.time) {
        state.chartCandles.push(chartCandle);
      }
      if (state.showSr && (c.closed === true || c.closed === 1)) {
        refreshSupportResistance();
      }
    }
  });

  ws.addEventListener("close", () => {
    $("feed-status").textContent = "reconnecting";
    setTimeout(connectWs, 1500);
  });
}

async function boot() {
  initChart();
  wireControls();
  setPage(pageFromHash());
  const metaRes = await fetch("/api/meta");
  state.meta = await metaRes.json();
  await loadSeries();
  connectWs();
  const stats = await fetch("/api/stats").then((r) => r.json());
  applySeriesCounts(stats);
  updatePnlCandleLimitField();
  $("stats").textContent = `${stats.ticks} ticks · ${stats.candles} candles`;
}

boot();
