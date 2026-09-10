/**
 * Martingale reset+break on Nth consecutive loss (multi-color junk):
 * never more than N real losses in a row — then reset stake + skip M minutes.
 */

function candleColor(c) {
  return Number(c.close) >= Number(c.open) ? "green" : "red";
}

function run(candles, opts) {
  const {
    baseStake = 1,
    payout = 2,
    martingale = true,
    capital = 10_000,
    martingaleResetBreak = true,
    resetBreakLosses = 3,
    resetBreakMinutes = 15,
  } = opts;
  const breakMs = resetBreakMinutes * 60 * 1000;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let consec = 0;
  let skipMode = null;
  let breakUntil = 0;

  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);

    if (martingaleResetBreak && skipMode === "wait_reset_break") {
      trades.push({
        skipped: true,
        predicted: "skipped",
        actual,
        openTimeMs: cur.openTimeMs,
        stake: 0,
      });
      if (cur.openTimeMs >= breakUntil) {
        skipMode = null;
        stake = baseStake;
        consec = 0;
      }
      continue;
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = predicted === actual;
    if (won) {
      balance += tradeStake * payout;
      consec = 0;
      if (martingale) stake = baseStake;
      trades.push({
        skipped: false,
        won: true,
        stake: tradeStake,
        openTimeMs: cur.openTimeMs,
      });
    } else {
      consec += 1;
      if (martingale) {
        stake =
          martingaleResetBreak && consec >= resetBreakLosses
            ? baseStake
            : tradeStake * 2;
      }
      trades.push({
        skipped: false,
        won: false,
        stake: tradeStake,
        openTimeMs: cur.openTimeMs,
      });
      if (martingaleResetBreak && consec >= resetBreakLosses) {
        skipMode = "wait_reset_break";
        breakUntil = cur.openTimeMs + breakMs;
        stake = baseStake;
        consec = 0;
      }
    }
  }
  return trades;
}

function c(ms, open, close) {
  return { openTimeMs: ms, open, close, closed: 1 };
}

const STEP = 5 * 60 * 1000;
const t0 = Date.UTC(2026, 2, 9, 12, 0, 0);
// Alternating colors → every color-follow trade loses.
const candles = [];
for (let i = 0; i < 20; i += 1) {
  const green = i % 2 === 0;
  candles.push(c(t0 + i * STEP, green ? 100 : 110, green ? 110 : 100));
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else console.log("ok:", msg);
}

const trades = run(candles, {
  resetBreakLosses: 3,
  resetBreakMinutes: 15,
});
const real = trades.filter((x) => !x.skipped);
const skips = trades.filter((x) => x.skipped);

assert(real.length >= 3, `placed real trades got ${real.length}`);
assert(real[0].stake === 1 && real[0].won === false, "loss1 stake 1");
assert(real[1].stake === 2 && real[1].won === false, "loss2 stake 2");
assert(real[2].stake === 4 && real[2].won === false, "loss3 stake 4");

// No more than 3 consecutive real losses before skips begin.
let maxConsec = 0;
let lossRun = 0;
for (const t of trades) {
  if (t.skipped) {
    lossRun = 0;
    continue;
  }
  if (t.won === false) {
    lossRun += 1;
    maxConsec = Math.max(maxConsec, lossRun);
  } else {
    lossRun = 0;
  }
}
assert(maxConsec === 3, `max consecutive losses must be 3, got ${maxConsec}`);
assert(skips.length >= 3, `break skips after 3rd loss, got ${skips.length}`);

const afterBreak = real[3];
assert(afterBreak, "resumed after break");
assert(
  afterBreak.stake === 1,
  `stake reset to base after break got ${afterBreak?.stake}`,
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("martingale reset+break (max N losses) checks passed");
