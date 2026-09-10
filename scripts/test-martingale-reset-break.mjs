/**
 * Martingale reset+break after multi-color (junk) repeat ends:
 * N+ losses (alternating colors), then a win ends junk → reset stake + skip M minutes.
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
      const junkLossRun = consec;
      consec = 0;
      if (martingale) stake = baseStake;
      trades.push({
        skipped: false,
        won: true,
        stake: tradeStake,
        openTimeMs: cur.openTimeMs,
      });
      // Junk (multi-color) repeat ended after N+ losses → reset + break.
      if (martingaleResetBreak && junkLossRun >= resetBreakLosses) {
        skipMode = "wait_reset_break";
        breakUntil = cur.openTimeMs + breakMs;
        stake = baseStake;
        consec = 0;
      }
    } else {
      consec += 1;
      if (martingale) stake = tradeStake * 2;
      trades.push({
        skipped: false,
        won: false,
        stake: tradeStake,
        openTimeMs: cur.openTimeMs,
      });
    }
  }
  return trades;
}

function c(ms, open, close) {
  return { openTimeMs: ms, open, close, closed: 1 };
}

const STEP = 5 * 60 * 1000;
const t0 = Date.UTC(2026, 2, 9, 12, 0, 0);

/**
 * Build: 3 losses (R/G/R/G alternating from green start) then a same-color win
 * that ends the multi-color junk, then enough candles for a 15m break.
 *
 * i=0 green, i=1 red → trade1 loss
 * i=2 green → trade2 loss
 * i=3 red → trade3 loss
 * i=4 red → trade4 win (junk ends) → break
 */
const candles = [
  c(t0 + 0 * STEP, 100, 110), // green
  c(t0 + 1 * STEP, 110, 100), // red  loss
  c(t0 + 2 * STEP, 100, 110), // green loss
  c(t0 + 3 * STEP, 110, 100), // red  loss
  c(t0 + 4 * STEP, 100, 90), // red  win — junk ends
];
for (let i = 5; i < 20; i += 1) {
  // continue red streak during break / resume
  candles.push(c(t0 + i * STEP, 100, 90));
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

assert(real.length >= 4, `placed real trades got ${real.length}`);
assert(real[0].won === false && real[0].stake === 1, "loss1 stake 1");
assert(real[1].won === false && real[1].stake === 2, "loss2 stake 2");
assert(real[2].won === false && real[2].stake === 4, "loss3 stake 4");
assert(real[3].won === true, "junk ends on win");
assert(skips.length >= 3, `break skips after junk ends, got ${skips.length}`);

const afterBreak = real[4];
assert(afterBreak, "resumed after break");
assert(
  afterBreak.stake === 1,
  `stake reset to base after break got ${afterBreak?.stake}`,
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("martingale reset+break (junk ends) checks passed");
