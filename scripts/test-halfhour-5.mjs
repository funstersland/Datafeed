/**
 * 5-loss half-hour break: skip 30m candle time, join continuation, loss → break again.
 */

function candleColor(c) {
  return Number(c.close) >= Number(c.open) ? "green" : "red";
}

function run(candles, opts) {
  const HALF = 30 * 60 * 1000;
  const {
    baseStake = 1,
    payout = 2,
    martingale = true,
    capital = 10000,
    halfHourBreak5 = true,
  } = opts;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let consec = 0;
  let skipMode = null;
  let breakUntil = 0;
  let halfHourArmed = false;
  let pendingJoin = false;
  let streak = null;

  const pushSkip = (cur) => {
    trades.push({
      skipped: true,
      predicted: "skipped",
      actual: candleColor(cur),
      openTimeMs: cur.openTimeMs,
    });
  };

  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);

    if (halfHourBreak5 && skipMode === "wait_half_hour") {
      pushSkip(cur);
      if (cur.openTimeMs >= breakUntil) {
        skipMode = "wait_two_same";
        pendingJoin = true;
      }
      continue;
    }
    if (halfHourBreak5 && skipMode === "wait_two_same") {
      pushSkip(cur);
      if (predicted === actual) {
        streak = actual;
        skipMode = "wait_third";
      }
      continue;
    }
    if (halfHourBreak5 && skipMode === "wait_third") {
      skipMode = null;
      if (pendingJoin) {
        halfHourArmed = true;
        pendingJoin = false;
      }
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = predicted === actual;
    if (won) {
      balance += tradeStake * payout;
      consec = 0;
      stake = baseStake;
      halfHourArmed = false;
      trades.push({ skipped: false, won: true, stake: tradeStake, openTimeMs: cur.openTimeMs });
    } else {
      consec += 1;
      stake = tradeStake * 2;
      trades.push({ skipped: false, won: false, stake: tradeStake, openTimeMs: cur.openTimeMs });
      if (consec >= 5 || halfHourArmed) {
        breakUntil = cur.openTimeMs + HALF;
        skipMode = "wait_half_hour";
        consec = 0;
        halfHourArmed = false;
      }
    }
  }
  return trades;
}

function mk(colors, startMs = 1_000_000, stepMs = 5 * 60 * 1000) {
  return colors.map((c, i) => ({
    open: c === "g" ? 1 : 2,
    close: c === "g" ? 2 : 1,
    closed: true,
    openTimeMs: startMs + i * stepMs,
  }));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  // 5 alternating losses on 5m candles, then time gap > 30m, then r,r,r continuation
  const colors = ["g", "r", "g", "r", "g", "r"]; // 5 losses at i=1..5
  // after 5th loss at index 5 (color r), break. Add skips within 30m then past 30m
  // Build manually with timestamps
  const candles = [];
  const step = 5 * 60 * 1000;
  let t = 1_000_000;
  const push = (c) => {
    candles.push({
      open: c === "g" ? 1 : 2,
      close: c === "g" ? 2 : 1,
      closed: true,
      openTimeMs: t,
    });
    t += step;
  };
  // g r g r g r  → 5 losses
  for (const c of ["g", "r", "g", "r", "g", "r"]) push(c);
  // within half hour: a few more
  push("g");
  push("r");
  // jump past 30m from 5th loss time
  // 5th loss was at candle index 5, time = 1_000_000 + 5*step
  const fifthLossTime = 1_000_000 + 5 * step;
  t = fifthLossTime + 31 * 60 * 1000;
  push("r");
  push("r");
  push("r"); // continuation entry

  const trades = run(candles, { halfHourBreak5: true });
  const losses = trades.filter((x) => !x.skipped && x.won === false);
  assert(losses.length >= 5, "at least 5 losses");
  const firstSkip = trades.findIndex((x) => x.skipped);
  assert(firstSkip === 5, `skip after 5th loss, got ${firstSkip}`);
  const afterBreak = trades.filter((x) => x.skipped);
  assert(afterBreak.length >= 2, "skipped during break");
  const resume = trades.find((x, i) => i > firstSkip && !x.skipped);
  assert(resume, "resumed after break + continuation");
}

console.log("Half-hour break checks passed.");
