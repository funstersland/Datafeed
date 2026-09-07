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

function formatMoney(value, { signed = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

function formatTradeTime(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Color-follow strategy:
 * predict the next closed candle matches the previous candle's color.
 * On flip (loss), follow the new color. Optional martingale doubles stake
 * after losses until unrecovered loss is covered, then resets to base.
 *
 * Capital wallet (example: capital 100, lot 1, payout 2):
 *   place lot → balance 99
 *   win  → total payout $2 credited → balance 101 (net +1)
 *   loss → lot stays gone → balance 99 (net -1)
 * If the next lot cannot be funded, or balance goes negative → account liquidated.
 */
function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, capital, candlesRequested },
) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const requested = Number.isFinite(candlesRequested)
    ? candlesRequested
    : usable.length;
  const notEnoughCandleData = usable.length < requested;
  const trades = [];
  let stake = baseStake;
  const startCapital = Number.isFinite(capital) ? capital : baseStake;
  let balance = startCapital;
  let peak = startCapital;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let unrecoveredLoss = 0;
  let maxStake = baseStake;
  let currentStreakColor = null;
  let currentStreakLen = 0;
  let longestStreak = 0;
  let liquidated = false;
  let liquidatedReason = null;
  let stopReason = "completed";

  if (usable.length < 2) {
    return {
      trades: [],
      candlesRequested: requested,
      candlesAvailable: usable.length,
      candlesUsed: usable.length,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      capital: startCapital,
      endingBalance: startCapital,
      netPnl: 0,
      maxDrawdown: 0,
      maxStake: baseStake,
      longestStreak: 0,
      martingale,
      baseStake,
      payout,
      liquidated: false,
      liquidatedReason: null,
      notEnoughCandleData: true,
      stopReason: "not_enough_candle_data",
      statusMessage: `Not Enough Candle Data — need at least 2 candles, have ${usable.length}`,
    };
  }

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);
    const won = predicted === actual;
    const tradeStake = stake;

    if (currentStreakColor === actual) {
      currentStreakLen += 1;
    } else {
      currentStreakColor = actual;
      currentStreakLen = 1;
    }
    longestStreak = Math.max(longestStreak, currentStreakLen);

    // Cannot fund this lot from capital → liquidated (candles may still remain).
    if (tradeStake > balance + 1e-9) {
      liquidated = true;
      liquidatedReason = `Account liquidated — lot ${tradeStake.toFixed(2)} exceeds balance ${balance.toFixed(2)}`;
      stopReason = "liquidated";
      break;
    }

    balance -= tradeStake;
    let payoutReturned = 0;
    let pnl = 0;

    if (won) {
      payoutReturned = tradeStake * payout;
      balance += payoutReturned;
      pnl = payoutReturned - tradeStake;
      wins += 1;
      if (martingale) {
        unrecoveredLoss = Math.max(0, unrecoveredLoss - pnl);
        if (unrecoveredLoss <= 1e-9) {
          unrecoveredLoss = 0;
          stake = baseStake;
        }
      }
    } else {
      payoutReturned = 0;
      pnl = -tradeStake;
      losses += 1;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        stake = tradeStake * 2;
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
      payoutReturned,
      pnl,
      balance,
      liquidated: liquidated && balance < -1e-9,
    });

    if (liquidated) break;
  }

  // Still have candle history left but cannot fund even the base lot.
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
    statusMessage = `Not Enough Candle Data — have ${usable.length}, requested ${requested}`;
    stopReason = "not_enough_candle_data";
  }

  return {
    trades,
    candlesRequested: requested,
    candlesAvailable: usable.length,
    candlesUsed: usable.length,
    candlesRemaining,
    tradeCount: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    capital: startCapital,
    endingBalance: balance,
    netPnl: balance - startCapital,
    maxDrawdown,
    maxStake,
    longestStreak,
    martingale,
    baseStake,
    payout,
    liquidated,
    liquidatedReason,
    notEnoughCandleData,
    stopReason,
    statusMessage,
  };
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
    ["Net PnL", formatMoney(result.netPnl), pnlClass],
    [
      "Capital → balance",
      `${formatMoney(result.capital, { signed: false })} → ${formatMoney(result.endingBalance, { signed: false })}`,
      result.liquidated ? "down" : "",
    ],
    ["Trades", String(result.tradeCount), ""],
    ["Wins", String(result.wins), "up"],
    ["Losses", String(result.losses), "down"],
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
      `${result.candlesAvailable} available / ${result.candlesRequested} requested`,
      result.notEnoughCandleData ? "down" : "",
    ],
    ["Mode", result.martingale ? "Martingale" : "Flat stake", ""],
  );
  $("pnl-summary").innerHTML = rows
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
      ? `<tr><td colspan="9">Showing last ${MAX_PNL_ROWS} of ${trades.length} trades (${omitted} earlier omitted)</td></tr>`
      : "",
    ...slice.map((t) => {
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
  const baseStake = Number($("pnl-stake").value);
  const payout = Number($("pnl-payout").value);
  const capital = Number($("pnl-capital").value);
  const limit = Math.min(44000, Math.max(50, Number($("pnl-limit").value) || 1500));
  const martingale = $("pnl-martingale").checked;

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
    `<div class="pnl-stat"><span class="label">Status</span><span class="value">Calculating ${state.pair} ${state.window}…</span></div>`;

  try {
    const res = await fetch(
      `/api/candles/${state.pair}/${state.window}?limit=${limit}`,
    );
    const data = await res.json();
    const candles = data.candles || [];
    if (candles.length < 2) {
      $("pnl-summary").innerHTML =
        `<div class="pnl-stat"><span class="label">Status</span><span class="value down">Not Enough Candle Data — need at least 2 candles for ${state.pair} ${state.window}, have ${candles.length}</span></div>`;
      $("pnl-table").hidden = true;
      return;
    }
    const result = runColorFollowStrategy(candles, {
      baseStake,
      payout,
      martingale,
      capital,
      candlesRequested: limit,
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
  ["pnl-capital", "pnl-stake", "pnl-payout"].forEach((id) => {
    $(id).addEventListener("input", updatePnlExample);
    $(id).addEventListener("change", updatePnlExample);
  });
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
