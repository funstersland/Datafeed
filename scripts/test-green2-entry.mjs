/**
 * Green-2 entry: after 1 green → bet next green → wait for red → repeat.
 * Mirror of Red-2 with martingale on every loss.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function candle({ o, c, t = 0 }) {
  return {
    open: o,
    high: Math.max(o, c),
    low: Math.min(o, c),
    close: c,
    openTimeMs: t,
    closed: true,
  };
}

function G(t) {
  return candle({ o: 100, c: 110, t });
}

function R(t) {
  return candle({ o: 100, c: 90, t });
}

function runColor2(
  candles,
  {
    signal = "green",
    baseStake = 1,
    payout = 2,
    capital = 100,
    martingale = true,
  } = {},
) {
  const opposite = signal === "green" ? "red" : "green";
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let unrecoveredLoss = 0;
  let phase =
    candleColor(usable[0]) === signal ? "bet_signal" : "wait_signal";

  for (let i = 1; i < usable.length; i += 1) {
    const cur = usable[i];
    const actual = candleColor(cur);

    if (phase === "wait_signal") {
      trades.push({ skipped: true, actual, predicted: "skipped", stake: 0 });
      if (actual === signal) phase = "bet_signal";
      continue;
    }
    if (phase === "wait_opposite") {
      trades.push({ skipped: true, actual, predicted: "skipped", stake: 0 });
      if (actual === opposite) phase = "wait_signal";
      continue;
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = actual === signal;
    let pnl = 0;
    if (won) {
      const returned = tradeStake * payout;
      balance += returned;
      pnl = returned - tradeStake;
      if (martingale) {
        unrecoveredLoss = Math.max(0, unrecoveredLoss - pnl);
        if (unrecoveredLoss <= 1e-9) {
          unrecoveredLoss = 0;
          stake = baseStake;
        }
      }
    } else {
      pnl = -tradeStake;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        stake = tradeStake * 2;
      }
    }
    trades.push({
      skipped: false,
      actual,
      predicted: signal,
      stake: tradeStake,
      won,
      pnl,
      balance,
    });
    phase = actual === opposite ? "wait_signal" : "wait_opposite";
  }

  return { trades, stake, balance, phase };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// R, G(signal), G(win), G(wait red), R(unlock), G(signal), R(loss)
const seq = [R(0), G(1), G(2), G(3), R(4), G(5), R(6)];
const r = runColor2(seq, { signal: "green" });
const real = r.trades.filter((t) => !t.skipped);
assert(real.length === 2, `expected 2 green bets, got ${real.length}`);
assert(real[0].predicted === "green" && real[0].won && real[0].stake === 1, "win @1");
assert(real[1].predicted === "green" && !real[1].won && real[1].stake === 1, "loss @1");
assert(r.stake === 2, "martingale after loss");
assert(r.phase === "wait_signal", "loss on red unlocks");

// Opening green arms first bet
// G, R(loss $1), G(signal), G(win $2)
const seq2 = [G(0), R(1), G(2), G(3)];
const r2 = runColor2(seq2, { signal: "green" });
const real2 = r2.trades.filter((t) => !t.skipped);
assert(real2.length === 2, "two bets");
assert(real2[0].stake === 1 && !real2[0].won, "first loss");
assert(real2[1].stake === 2 && real2[1].won, "martingale win");
assert(r2.stake === 1, "stake reset");
assert(Math.abs(r2.balance - 101) < 1e-9, `balance 101 got ${r2.balance}`);

// After green win, reds during wait_opposite are skipped until red unlocks... 
// wait: opposite of green is red, so wait_opposite waits for red.
// G, G(win), G(still wait red - skip), R(unlock), G(signal), G(bet)
const seq3 = [G(0), G(1), G(2), R(3), G(4), G(5)];
const r3 = runColor2(seq3, { signal: "green" });
const real3 = r3.trades.filter((t) => !t.skipped);
assert(real3.length === 2, `expected 2 bets seq3, got ${real3.length}`);
assert(real3.every((t) => t.won), "both wins");
assert(
  r3.trades.some((t, idx) => t.skipped && t.actual === "green" && idx > 0),
  "green during wait_opposite skipped",
);

console.log("ok: green-2 entry martingale");
