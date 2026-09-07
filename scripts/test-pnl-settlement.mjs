/**
 * Capital wallet: lot subtracted every round; win profit credited to balance.
 * Liquidate when the next lot cannot be funded or balance goes negative.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, capital },
) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const trades = [];
  let stake = baseStake;
  const startCapital = Number.isFinite(capital) ? capital : baseStake;
  let balance = startCapital;
  let unrecoveredLoss = 0;
  let liquidated = false;
  let liquidatedReason = null;
  let wins = 0;
  let losses = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);
    const won = predicted === actual;
    const tradeStake = stake;

    if (tradeStake > balance + 1e-9) {
      liquidated = true;
      liquidatedReason = `Account liquidated — lot ${tradeStake.toFixed(2)} exceeds balance ${balance.toFixed(2)}`;
      break;
    }

    balance -= tradeStake;
    let pnl = 0;
    let profit = 0;

    if (won) {
      profit = tradeStake * payout;
      balance += profit;
      pnl = profit;
      wins += 1;
      if (martingale) {
        const netGain = profit - tradeStake;
        unrecoveredLoss = Math.max(0, unrecoveredLoss - netGain);
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

    if (balance < -1e-9) {
      liquidated = true;
      liquidatedReason = "Account liquidated — balance went negative";
    }

    trades.push({ won, stake: tradeStake, pnl, profit, balance, liquidated: balance < -1e-9 });
    if (liquidated) break;
  }

  if (!liquidated && balance + 1e-9 < baseStake && usable.length > trades.length + 1) {
    liquidated = true;
    liquidatedReason = "Account liquidated — capital exhausted";
  }

  return {
    trades,
    wins,
    losses,
    netPnl: balance - startCapital,
    endingBalance: balance,
    capital: startCapital,
    liquidated,
    liquidatedReason,
  };
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

function candlesFromColors(colors) {
  return colors.map((c, i) => ({
    open: c === "green" ? 1 : 2,
    close: c === "green" ? 2 : 1,
    closed: true,
    openTimeMs: i * 1000,
  }));
}

// User example: capital 1, lot 1, payout 2 → 2, 1, 2
{
  const { trades, netPnl, liquidated } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "red", "red"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 1 },
  );
  assertClose(trades[0].pnl, 2, "T1 profit");
  assertClose(trades[0].balance, 2, "T1 balance");
  assertClose(trades[1].pnl, -1, "T2 loss");
  assertClose(trades[1].balance, 1, "T2 balance");
  assertClose(trades[2].pnl, 2, "T3 profit");
  assertClose(trades[2].balance, 2, "T3 balance");
  assertClose(netPnl, 1, "net");
  assert(!liquidated, "not liquidated");
}

// Lot always subtracted, profit always added (capital 100)
{
  const { trades } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "red"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 100 },
  );
  // win: 100-1+2 = 101
  assertClose(trades[0].balance, 101, "capital win balance");
  // loss: 101-1 = 100
  assertClose(trades[1].balance, 100, "capital loss balance");
}

// Liquidated when martingale lot exceeds remaining balance
{
  // capital 2: loss → bal 1, next lot 2 > 1 → liquidated before placing
  const { trades, liquidated, liquidatedReason, endingBalance } =
    runColorFollowStrategy(
      candlesFromColors(["green", "red", "green", "green", "green"]),
      { baseStake: 1, payout: 2, martingale: true, capital: 2 },
    );
  assert(liquidated, "should liquidate");
  assert(
    /Account liquidated/i.test(liquidatedReason || ""),
    `reason should say liquidated, got: ${liquidatedReason}`,
  );
  assertClose(trades.length, 1, "one trade then stop");
  assertClose(endingBalance, 1, "balance left after first loss");
  assertClose(trades[0].balance, 1, "first loss balance");
}

// Capital exhausted after wiping balance to 0
{
  const { trades, liquidated, liquidatedReason } = runColorFollowStrategy(
    candlesFromColors(["green", "red", "red", "green", "green"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 1 },
  );
  // start 1; predict green actual red → loss → balance 0 → liquidated (can't continue)
  assertClose(trades[0].balance, 0, "wiped");
  assert(liquidated, "exhausted capital liquidates");
  assert(/liquidated/i.test(liquidatedReason || ""), "liquidated message");
}

console.log("All capital / liquidation checks passed.");
