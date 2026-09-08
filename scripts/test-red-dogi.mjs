/**
 * RedDogi: after 5+ continuous greens then a red signal, bet red until green.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function c(color, t = 0) {
  return color === "green"
    ? { open: 1, close: 2, openTimeMs: t, closed: true }
    : { open: 2, close: 1, openTimeMs: t, closed: true };
}

function runRedDogi(candles, { baseStake = 1, payout = 2, capital = 100 } = {}) {
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let dogiPhase = "hunt";
  let dogiGreenStreak = candleColor(usable[0]) === "green" ? 1 : 0;
  let wins = 0;
  let losses = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const cur = usable[i];
    const actual = candleColor(cur);

    if (dogiPhase === "hunt") {
      trades.push({ skipped: true, actual, predicted: "skipped" });
      if (actual === "green") dogiGreenStreak += 1;
      else {
        if (dogiGreenStreak >= 5) dogiPhase = "bet_red";
        dogiGreenStreak = 0;
      }
      continue;
    }

    balance -= stake;
    const won = actual === "red";
    let pnl = 0;
    if (won) {
      const pay = stake * payout;
      balance += pay;
      pnl = pay - stake;
      wins += 1;
    } else {
      pnl = -stake;
      losses += 1;
    }
    trades.push({ skipped: false, predicted: "red", actual, won, stake, pnl, balance });

    if (actual === "green") {
      dogiPhase = "hunt";
      dogiGreenStreak = 1;
    } else {
      dogiGreenStreak = 0;
    }
  }

  return { trades, wins, losses, balance, dogiPhase };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 5 greens then red signal then R,R,G — should bet on the two reds and lose on green
{
  const candles = [
    c("green", 0),
    c("green", 1),
    c("green", 2),
    c("green", 3),
    c("green", 4), // 5th green (index 0..4)
    c("red", 5), // signal
    c("red", 6), // bet win
    c("red", 7), // bet win
    c("green", 8), // bet loss → stop
    c("green", 9),
  ];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 3, `expected 3 bets, got ${real.length}`);
  assert(real[0].won && real[0].actual === "red", "first bet win red");
  assert(real[1].won && real[1].actual === "red", "second bet win red");
  assert(!real[2].won && real[2].actual === "green", "third bet loss green");
  assert(r.wins === 2 && r.losses === 1, "2W 1L");
}

// Only 4 greens then red — no signal, no bets
{
  const candles = [
    c("green", 0),
    c("green", 1),
    c("green", 2),
    c("green", 3),
    c("red", 4),
    c("red", 5),
    c("red", 6),
  ];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 0, "no bets without 5 greens");
}

// 6 greens then red — still signals
{
  const candles = [
    c("green", 0),
    c("green", 1),
    c("green", 2),
    c("green", 3),
    c("green", 4),
    c("green", 5),
    c("red", 6), // signal
    c("red", 7), // bet
    c("green", 8),
  ];
  const r = runRedDogi(candles);
  const real = r.trades.filter((t) => !t.skipped);
  assert(real.length === 2, `expected 2 bets, got ${real.length}`);
  assert(real[0].won, "win");
  assert(!real[1].won, "loss on green");
}

console.log("ok: RedDogi");
