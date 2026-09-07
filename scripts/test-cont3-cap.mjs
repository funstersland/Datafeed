/**
 * Continuation-3 entry + martingale cap@3 checks.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(
  candles,
  {
    baseStake,
    payout,
    martingale,
    capital,
    skipFilter = false,
    cont3Entry = false,
    martingaleCap3 = false,
  },
) {
  const usable = candles;
  const trades = [];
  let stake = baseStake;
  let balance = capital;
  let unrecoveredLoss = 0;
  let consecutiveLosses = 0;
  let skipMode = null;
  let streakColor = null;
  let resumeArmed = false;
  const useSkip = Boolean(skipFilter) && !cont3Entry;
  const useCont3 = Boolean(cont3Entry);
  const useCap3 = Boolean(martingaleCap3);
  const useWait = useSkip || useCont3;

  const pushSkip = (cur) => {
    trades.push({
      predicted: "skipped",
      actual: candleColor(cur),
      skipped: true,
      stake: 0,
      balance,
    });
  };

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);

    if (useWait && skipMode === "wait_two_same") {
      pushSkip(cur);
      if (predicted === actual) {
        streakColor = actual;
        skipMode = useCont3 ? "wait_third" : "wait_break";
      }
      continue;
    }

    if (useSkip && skipMode === "wait_break") {
      if (actual === streakColor) {
        pushSkip(cur);
        continue;
      }
      skipMode = null;
      streakColor = null;
      resumeArmed = true;
    }

    if (useCont3 && skipMode === "wait_third") {
      skipMode = null;
      streakColor = null;
      resumeArmed = true;
    }

    const tradeStake = stake;
    balance -= tradeStake;
    const won = predicted === actual;

    if (won) {
      const pay = tradeStake * payout;
      balance += pay;
      consecutiveLosses = 0;
      if (martingale) {
        unrecoveredLoss = Math.max(0, unrecoveredLoss - (pay - tradeStake));
        if (unrecoveredLoss <= 1e-9) {
          unrecoveredLoss = 0;
          stake = baseStake;
          resumeArmed = false;
        }
      } else resumeArmed = false;
      trades.push({ won: true, skipped: false, stake: tradeStake, predicted, actual });
    } else {
      consecutiveLosses += 1;
      if (martingale) {
        unrecoveredLoss += tradeStake;
        stake =
          useCap3 && consecutiveLosses >= 3 ? baseStake : tradeStake * 2;
      }
      trades.push({ won: false, skipped: false, stake: tradeStake, predicted, actual, nextStake: stake });
      if (
        useWait &&
        (consecutiveLosses >= 3 ||
          (resumeArmed && (martingale ? unrecoveredLoss > 1e-9 : true)))
      ) {
        skipMode = "wait_two_same";
        streakColor = null;
        consecutiveLosses = 0;
      }
    }
  }
  return { trades, stake, balance };
}

function mk(colors) {
  return colors.map((c) => ({
    open: c === "g" ? 1 : 2,
    close: c === "g" ? 2 : 1,
    closed: true,
  }));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Cap@3: stakes 1,2,4 then reset — never 8
{
  const colors = ["g", "r", "g", "r", "g", "r"];
  const { trades } = runColorFollowStrategy(mk(colors), {
    baseStake: 1,
    payout: 2,
    martingale: true,
    capital: 1000,
    martingaleCap3: true,
  });
  assert(trades[0].stake === 1, "L1 stake 1");
  assert(trades[1].stake === 2, "L2 stake 2");
  assert(trades[2].stake === 4, "L3 stake 4");
  assert(trades[2].nextStake === 1, "after 3rd loss reset to base");
  assert(trades[3].stake === 1, "4th trade is base not 8");
}

// Cont3: after 3 losses, skip until 2 same, trade 3rd same-color candle
{
  // 3 alternating losses, then r,r,r → entry on 3rd red
  const seq = ["g", "r", "g", "r", "r", "r"];
  const { trades } = runColorFollowStrategy(mk(seq), {
    baseStake: 1,
    payout: 2,
    martingale: true,
    capital: 1000,
    cont3Entry: true,
  });
  assert(trades[0].won === false && trades[1].won === false && trades[2].won === false, "3 losses");
  assert(trades[3].skipped === true, "skip on 2nd same while arming");
  const entry = trades.find((t, i) => i > 3 && !t.skipped);
  assert(entry, "continuation entry exists");
  assert(entry.predicted === "red", `entry predicts red (3rd same), got ${entry.predicted}`);
  assert(entry.actual === "red" && entry.won === true, "3rd red wins");
}

console.log("Cont3 + martingale cap checks passed.");
