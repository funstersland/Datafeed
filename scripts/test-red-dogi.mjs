/**
 * RedDogi: net upside pull → red doji signal → bet next red once → leave → repeat.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function isDoji(candle, { maxBodyRatio = 0.25 } = {}) {
  const open = Number(candle.open);
  const close = Number(candle.close);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const body = Math.abs(close - open);
  const range = high - low;
  if (range <= 1e-12) return body <= 1e-12;
  return body / range <= maxBodyRatio;
}

function isRedDoji(candle) {
  return candleColor(candle) === "red" && isDoji(candle);
}

function netCandlePull(candles, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  let sum = 0;
  for (let i = start; i < endIdx; i += 1) {
    sum += Number(candles[i].close) - Number(candles[i].open);
  }
  return sum;
}

function candle({ o, h, l, c, t = 0 }) {
  return { open: o, high: h, low: l, close: c, openTimeMs: t, closed: true };
}

// Strong green (big body)
function G(t, move = 10) {
  return candle({ o: 100, h: 100 + move, l: 99, c: 100 + move, t });
}
// Red with large body (not doji)
function R(t, move = 10) {
  return candle({ o: 100, h: 101, l: 100 - move, c: 100 - move, t });
}
// Red doji: close slightly below open, long wicks
function RD(t) {
  return candle({ o: 100, h: 105, l: 95, c: 99.5, t });
}

function runRedDogi(candles, { baseStake = 1, payout = 2, capital = 100 } = {}) {
  const LOOKBACK = 5;
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let dogiPhase = "hunt";
  let wins = 0;
  let losses = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const cur = usable[i];
    const actual = candleColor(cur);

    if (dogiPhase === "hunt") {
      trades.push({ skipped: true, actual, predicted: "skipped", i });
      if (
        i >= LOOKBACK &&
        isRedDoji(cur) &&
        netCandlePull(usable, i, LOOKBACK) > 0
      ) {
        dogiPhase = "bet_once";
      }
      continue;
    }

    balance -= stake;
    const won = actual === "red";
    if (won) {
      balance += stake * payout;
      wins += 1;
    } else {
      losses += 1;
    }
    trades.push({
      skipped: false,
      predicted: "red",
      actual,
      won,
      stake,
      balance,
      i,
    });
    dogiPhase = "hunt";
  }

  return { trades, wins, losses, balance };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(isRedDoji(RD(0)), "RD is red doji");
assert(!isDoji(R(0)), "large red is not doji");
assert(!isRedDoji(G(0)), "green is not red doji");

// Upside pull (5 greens) → red doji → bet once on next (red win) → leave
{
  const candles = [
    G(0),
    G(1),
    G(2),
    G(3),
    G(4), // lookback net upside
    RD(5), // signal
    R(6), // bet — win
    G(7),
    G(8),
  ];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 1, `expected 1 bet, got ${real.length}`);
  assert(real[0].won && real[0].i === 6, "bet on candle after doji");
  assert(r.wins === 1 && r.losses === 0, "1W");
}

// Upside with mixed reds still nets up → red doji → bet
{
  const candles = [
    G(0, 20),
    R(1, 5),
    G(2, 20),
    R(3, 5),
    G(4, 20),
    RD(5),
    G(6), // bet — loss (green)
    RD(7), // not enough new upside yet / may or may not arm
  ];
  const pull = netCandlePull(candles, 5, 5);
  assert(pull > 0, `expected upside pull, got ${pull}`);
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length >= 1, "at least one bet");
  assert(real[0].i === 6 && !real[0].won, "first bet is loss on green");
}

// No upside (all red) → red doji should NOT arm
{
  const candles = [R(0), R(1), R(2), R(3), R(4), RD(5), R(6), R(7)];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 0, "no bet without upside pull");
}

// Large red (not doji) after upside — no signal
{
  const candles = [G(0), G(1), G(2), G(3), G(4), R(5, 20), R(6), R(7)];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 0, "no bet without doji");
}

console.log("ok: RedDogi upside+doji");
