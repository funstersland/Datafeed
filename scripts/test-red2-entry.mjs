/**
 * Red-2 entry: after 1 red → bet next red → wait for green → repeat.
 * Martingale doubles stake after every loss until recovered.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function candle({ o, c, t = 0 }) {
  return { open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, openTimeMs: t, closed: true };
}

function G(t) {
  return candle({ o: 100, c: 110, t });
}

function R(t) {
  return candle({ o: 100, c: 90, t });
}

function runRed2(candles, { baseStake = 1, payout = 2, capital = 100, martingale = true } = {}) {
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let unrecoveredLoss = 0;
  let phase = candleColor(usable[0]) === "red" ? "bet_red" : "wait_red";
  let wins = 0;
  let losses = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const cur = usable[i];
    const actual = candleColor(cur);

    if (phase === "wait_red") {
      trades.push({ skipped: true, actual, predicted: "skipped", stake: 0 });
      if (actual === "red") phase = "bet_red";
      continue;
    }
    if (phase === "wait_green") {
      trades.push({ skipped: true, actual, predicted: "skipped", stake: 0 });
      if (actual === "green") phase = "wait_red";
      continue;
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = actual === "red";
    let pnl = 0;
    if (won) {
      const returned = tradeStake * payout;
      balance += returned;
      pnl = returned - tradeStake;
      wins += 1;
      if (martingale) {
        unrecoveredLoss = Math.max(0, unrecoveredLoss - pnl);
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
    trades.push({
      skipped: false,
      actual,
      predicted: "red",
      stake: tradeStake,
      won,
      pnl,
      balance,
    });
    phase = actual === "green" ? "wait_red" : "wait_green";
  }

  return { trades, wins, losses, balance, stake, phase };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// G, R(signal), R(win bet), R(still waiting green), G(unlock), R(signal), G(loss bet martingale)
const seq = [G(0), R(1), R(2), R(3), G(4), R(5), G(6)];
const r = runRed2(seq, { baseStake: 1, payout: 2, capital: 100, martingale: true });

const real = r.trades.filter((t) => !t.skipped);
assert(real.length === 2, `expected 2 bets, got ${real.length}`);
assert(real[0].won === true && real[0].stake === 1, "first bet win @1");
assert(real[1].won === false && real[1].stake === 1, "second bet loss @1 (prior win recovered)");
assert(r.stake === 2, `after loss stake should be 2, got ${r.stake}`);
assert(r.phase === "wait_red", "loss on green → immediately wait_red");

const skips = r.trades.filter((t) => t.skipped);
assert(skips[0].actual === "red", "first skip is red signal");
assert(skips.some((t) => t.actual === "green"), "later wait includes green");
assert(
  skips.filter((t) => t.actual === "red").length >= 2,
  "at least two red skips (signals)",
);

// Loss then martingale win recovers
// R signal, G loss($1), R signal, R win($2) → net +1, stake back to 1
const seq2 = [R(0), G(1), R(2), R(3)];
const r2 = runRed2(seq2, { baseStake: 1, payout: 2, capital: 100, martingale: true });
const real2 = r2.trades.filter((t) => !t.skipped);
assert(real2.length === 2, "two bets in seq2");
assert(real2[0].stake === 1 && real2[0].won === false, "loss $1");
assert(real2[1].stake === 2 && real2[1].won === true, "martingale win $2");
assert(r2.stake === 1, "stake reset after recovery");
assert(Math.abs(r2.balance - 101) < 1e-9, `balance 101, got ${r2.balance}`);

// After win (red), must wait for green before next red signal
// R, R(win), R(should skip — still wait green), G, R(signal), R(bet)
const seq3 = [R(0), R(1), R(2), G(3), R(4), R(5)];
const r3 = runRed2(seq3, { baseStake: 1, payout: 2, capital: 100, martingale: true });
const real3 = r3.trades.filter((t) => !t.skipped);
assert(real3.length === 2, `expected 2 bets in seq3, got ${real3.length}`);
assert(real3[0].won && real3[1].won, "both wins");
const midSkip = r3.trades.find((t, idx) => {
  // the R after first win should be skipped (wait_green)
  return t.skipped && t.actual === "red" && idx > 1;
});
assert(midSkip, "red during wait_green is skipped");

console.log("ok: red-2 entry martingale");
