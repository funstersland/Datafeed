/* global LightweightCharts from CDN */
/* eslint-disable no-undef */

const state = {
  pair: "BTC",
  window: "5m",
  meta: [],
  chart: null,
  series: null,
};

const MAX_PNL_ROWS = 250;

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

function toChartCandle(row) {
  return {
    time: Math.floor(row.openTimeMs / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  };
}

function initChart() {
  const el = $("chart");
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

  window.addEventListener("resize", () => {
    state.chart.applyOptions({
      width: el.clientWidth,
      height: el.clientHeight,
    });
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
  state.series.setData(candles);
  if (data.candles?.length) updateOhlc(data.candles[data.candles.length - 1]);
  state.chart.timeScale().fitContent();
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

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatTradeTime(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Color-follow strategy:
 * predict the next closed candle matches the previous candle's color.
 * On flip (loss), follow the new color. Optional martingale doubles stake
 * after losses until unrecovered loss is covered, then resets to base.
 *
 * Wallet settlement — every round reinvests stake from balance:
 *   balance -= stake
 *   on win:  balance += stake * payout   (PnL column shows that credit)
 *   on loss: stake stays gone            (PnL = -stake)
 *
 * Example (start 1, stake 1, payout 2):
 *   win  → balance 2, pnl +2
 *   loss → balance 1, pnl -1
 *   win  → balance 2, pnl +2   (not 3 — the reinvested $1 was deducted)
 */
function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, startingBalance },
) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const trades = [];
  let stake = baseStake;
  const startBal = Number.isFinite(startingBalance)
    ? startingBalance
    : baseStake;
  let balance = startBal;
  let peak = startBal;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let unrecoveredLoss = 0;
  let maxStake = baseStake;
  let currentStreakColor = null;
  let currentStreakLen = 0;
  let longestStreak = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);
    const won = predicted === actual;
    const tradeStake = stake;
    let pnl = 0;

    if (currentStreakColor === actual) {
      currentStreakLen += 1;
    } else {
      currentStreakColor = actual;
      currentStreakLen = 1;
    }
    longestStreak = Math.max(longestStreak, currentStreakLen);

    // Reinvest: pull stake out of wallet before the round resolves.
    balance -= tradeStake;

    if (won) {
      // payout is total cash returned for this stake (2 = even money: $1 → $2).
      const winCredit = tradeStake * payout;
      balance += winCredit;
      pnl = winCredit;
      wins += 1;
      if (martingale) {
        const netGain = winCredit - tradeStake;
        unrecoveredLoss = Math.max(0, unrecoveredLoss - netGain);
        if (unrecoveredLoss <= 1e-9) {
          unrecoveredLoss = 0;
          stake = baseStake;
        }
      }
    } else {
      pnl = -tradeStake;
      losses += 1;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        stake = tradeStake * 2;
      }
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
      pnl,
      balance,
    });
  }

  return {
    trades,
    candlesUsed: usable.length,
    tradeCount: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    startingBalance: startBal,
    endingBalance: balance,
    netPnl: balance - startBal,
    maxDrawdown,
    maxStake,
    longestStreak,
    martingale,
    baseStake,
    payout,
  };
}

function renderPnlSummary(result) {
  const pnlClass = result.netPnl >= 0 ? "up" : "down";
  $("pnl-summary").innerHTML = [
    ["Net PnL", formatMoney(result.netPnl), pnlClass],
    ["Start / end", `${formatMoney(result.startingBalance).replace("+", "")} → ${formatMoney(result.endingBalance).replace("+", "")}`, ""],
    ["Trades", String(result.tradeCount), ""],
    ["Wins", String(result.wins), "up"],
    ["Losses", String(result.losses), "down"],
    ["Win rate", formatPct(result.winRate), ""],
    ["Max drawdown", formatMoney(-result.maxDrawdown), "down"],
    ["Max stake", formatMoney(result.maxStake).replace("+", ""), ""],
    ["Longest color streak", String(result.longestStreak), ""],
    ["Candles used", String(result.candlesUsed), ""],
    ["Mode", result.martingale ? "Martingale" : "Flat stake", ""],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="pnl-stat"><span class="label">${label}</span><span class="value ${cls}">${value}</span></div>`,
    )
    .join("");
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
      ? `<tr><td colspan="8">Showing last ${MAX_PNL_ROWS} of ${trades.length} trades (${omitted} earlier omitted)</td></tr>`
      : "",
    ...slice.map((t) => {
      const resultClass = t.won ? "win" : "loss";
      return `<tr>
        <td>${t.index}</td>
        <td>${formatTradeTime(t.openTimeMs)}</td>
        <td class="color-${t.predicted}">${t.predicted}</td>
        <td class="color-${t.actual}">${t.actual}</td>
        <td>${formatMoney(t.stake).replace("+", "")}</td>
        <td class="${resultClass}">${t.won ? "win" : "loss"}</td>
        <td class="${resultClass}">${formatMoney(t.pnl)}</td>
        <td class="${t.balance >= 0 ? "win" : "loss"}">${formatMoney(t.balance)}</td>
      </tr>`;
    }),
  ].join("");
  table.hidden = false;
}

async function calculatePnl() {
  const baseStake = Number($("pnl-stake").value);
  const payout = Number($("pnl-payout").value);
  const startingBalance = Number($("pnl-start").value);
  const limit = Math.min(44000, Math.max(50, Number($("pnl-limit").value) || 1500));
  const martingale = $("pnl-martingale").checked;

  if (!Number.isFinite(baseStake) || baseStake <= 0) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Base stake must be &gt; 0</span></div>`;
    return;
  }
  if (!Number.isFinite(payout) || payout < 1) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Win return must be ≥ 1 (2 = even money: stake $1 returns $2)</span></div>`;
    return;
  }
  if (!Number.isFinite(startingBalance) || startingBalance < baseStake) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Starting balance must cover base stake</span></div>`;
    return;
  }

  $("pnl-run").disabled = true;
  $("pnl-summary").innerHTML =
    `<div class="pnl-stat"><span class="label">Status</span><span class="value">Calculating ${state.pair} ${state.window}…</span></div>`;

  try {
    const res = await fetch(
      `/api/candles/${state.pair}/${state.window}?limit=${limit}`,
    );
    const data = await res.json();
    const candles = data.candles || [];
    if (candles.length < 2) {
      $("pnl-summary").innerHTML =
        `<div class="pnl-stat"><span class="label">Error</span><span class="value down">Need at least 2 candles</span></div>`;
      $("pnl-table").hidden = true;
      return;
    }
    const result = runColorFollowStrategy(candles, {
      baseStake,
      payout,
      martingale,
      startingBalance,
    });
    renderPnlSummary(result);
    renderPnlTrades(result.trades);
  } catch (err) {
    $("pnl-summary").innerHTML =
      `<div class="pnl-stat"><span class="label">Error</span><span class="value down">${String(err.message || err)}</span></div>`;
  } finally {
    $("pnl-run").disabled = false;
  }
}

function wireControls() {
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
  $("download-csv").addEventListener("click", () => downloadChartData("csv"));
  $("download-json").addEventListener("click", () => downloadChartData("json"));
  $("pnl-run").addEventListener("click", () => calculatePnl());
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
      }
    }
    if (msg.type === "meta") {
      state.meta = msg.meta || [];
      updateMetaCopy();
    }
    if (msg.type === "candle") {
      const c = msg.candle;
      if (c.pair !== state.pair || c.window !== state.window) return;
      state.series.update(toChartCandle(c));
      updateOhlc(c);
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
  const metaRes = await fetch("/api/meta");
  state.meta = await metaRes.json();
  await loadSeries();
  connectWs();
  const stats = await fetch("/api/stats").then((r) => r.json());
  $("stats").textContent = `${stats.ticks} ticks · ${stats.candles} candles`;
}

boot();
