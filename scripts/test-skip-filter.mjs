/**
 * Skip filter: after 3 consecutive losses, skip until 2 same colors then a break;
 * resume martingale; any loss before recovery waits again; skipped rows labeled.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, capital, skipFilter = false },
) {
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let unrecoveredLoss = 0;
  let consecutiveLosses = 0;
  let skipMode = null;
  let waitBreakColor = null;
  let resumeArmed = false;
  let skips = 0;

  const pushSkip = (cur) => {
    skips += 1;
    trades.push({
      predicted: "skipped",
      actual: "skipped",
      skipped: true,
      stake: 0,
      pnl: 0,
      balance,
    });
  };

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);

    if (skipFilter && skipMode === "wait_two_same") {
      pushSkip(cur);
      if (predicted === actual) {
        waitBreakColor = actual;
        skipMode = "wait_break";
      }
      continue;
    }

    if (skipFilter && skipMode === "wait_break") {
      if (actual === waitBreakColor) {
        pushSkip(cur);
        continue;
      }
      skipMode = null;
      waitBreakColor = null;
      resumeArmed = true;
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = predicted === actual;
    let pnl = 0;

    if (won) {
      const payoutReturned = tradeStake * payout;
      balance += payoutReturned;
      pnl = payoutReturned - tradeStake;
      consecutiveLosses = 0;
      if (martingale) {
        unrecoveredLoss = Math.max(0, unrecoveredLoss - pnl);
        if (unrecoveredLoss <= 1e-9) {
          unrecoveredLoss = 0;
          stake = baseStake;
          resumeArmed = false;
        }
      } else {
        resumeArmed = false;
      }
    } else {
      pnl = -tradeStake;
      consecutiveLosses += 1;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        stake = tradeStake * 2;
      }
    }

    trades.push({
      predicted,
      actual,
      skipped: false,
      stake: tradeStake,
      won,
      pnl,
      balance,
    });

    if (
      skipFilter &&
      !won &&
      (consecutiveLosses >= 3 ||
        (resumeArmed && (martingale ? unrecoveredLoss > 1e-9 : true)))
    ) {
      skipMode = "wait_two_same";
      waitBreakColor = null;
      consecutiveLosses = 0;
    }
  }

  return { trades, skips, endingBalance: balance, unrecoveredLoss, stake };
}

function candlesFromColors(colors) {
  return colors.map((c) => ({
    open: c === "green" || c === "g" ? 1 : 2,
    close: c === "green" || c === "g" ? 2 : 1,
    closed: true,
  }));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const colors = ["g", "r", "g", "r", "g", "r", "r", "g", "r"];
  const { trades, skips } = runColorFollowStrategy(candlesFromColors(colors), {
    baseStake: 1,
    payout: 2,
    martingale: true,
    capital: 1000,
    skipFilter: true,
  });
  assert(trades[0].won === false, "T1 loss");
  assert(trades[1].won === false, "T2 loss");
  assert(trades[2].won === false, "T3 loss");
  assert(trades[3].skipped === true, "first skip after 3 losses");
  assert(trades[3].predicted === "skipped", "predict skipped");
  assert(trades[3].actual === "skipped", "actual skipped");
  assert(skips >= 3, `expected skips, got ${skips}`);

  const resume = trades.find((t, i) => i > 3 && !t.skipped);
  assert(resume, "should resume after 2-same + break");
  assert(resume.stake === 8, `resume stake should continue martingale at 8, got ${resume.stake}`);
}

{
  // Without skip filter, no skipped rows after alternating losses
  const colors = ["g", "r", "g", "r", "g", "r", "r", "g"];
  const { trades, skips } = runColorFollowStrategy(candlesFromColors(colors), {
    baseStake: 1,
    payout: 2,
    martingale: true,
    capital: 1000,
    skipFilter: false,
  });
  assert(skips === 0, "no skips without filter");
  assert(trades.every((t) => !t.skipped), "all rows traded");
}

console.log("Skip filter checks passed.");
