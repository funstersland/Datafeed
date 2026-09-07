/**
 * Capital wallet: lot subtracted every round; win returns total payout to balance.
 * Net PnL = payout − lot on wins, −lot on losses.
 * Liquidate when the next lot cannot be funded or balance goes negative.
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, capital, candlesRequested },
) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const requested = Number.isFinite(candlesRequested)
    ? candlesRequested
    : usable.length;
  const notEnoughCandleData = usable.length < requested;
  const trades = [];
  let stake = baseStake;
  const startCapital = Number.isFinite(capital) ? capital : baseStake;
  let balance = startCapital;
  let unrecoveredLoss = 0;
  let liquidated = false;
  let liquidatedReason = null;
  let stopReason = "completed";
  let wins = 0;
  let losses = 0;

  if (usable.length < 2) {
    return {
      trades: [],
      wins: 0,
      losses: 0,
      netPnl: 0,
      endingBalance: startCapital,
      capital: startCapital,
      liquidated: false,
      liquidatedReason: null,
      notEnoughCandleData: true,
      stopReason: "not_enough_candle_data",
      statusMessage: `Not Enough Candle Data — need at least 2 candles, have ${usable.length}`,
      candlesAvailable: usable.length,
      candlesRequested: requested,
    };
  }

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
      stopReason = "liquidated";
      break;
    }

    balance -= tradeStake;
    let payoutReturned = 0;
    let pnl = 0;

    if (won) {
      payoutReturned = tradeStake * payout;
      balance += payoutReturned;
      pnl = payoutReturned - tradeStake;
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

    if (balance < -1e-9) {
      liquidated = true;
      liquidatedReason = "Account liquidated — balance went negative";
      stopReason = "liquidated";
    }

    trades.push({
      won,
      stake: tradeStake,
      payoutReturned,
      pnl,
      balance,
      liquidated: balance < -1e-9,
    });
    if (liquidated) break;
  }

  const candlesRemaining = Math.max(0, usable.length - (trades.length + 1));
  if (!liquidated && balance + 1e-9 < baseStake && candlesRemaining > 0) {
    liquidated = true;
    liquidatedReason = "Account liquidated — capital exhausted";
    stopReason = "liquidated";
  }

  let statusMessage = null;
  if (stopReason === "liquidated") {
    statusMessage = `${liquidatedReason} (${candlesRemaining} candle${candlesRemaining === 1 ? "" : "s"} still unused — not a data shortage)`;
  } else if (notEnoughCandleData) {
    statusMessage = `Not Enough Candle Data — have ${usable.length}, requested ${requested}`;
    stopReason = "not_enough_candle_data";
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
    notEnoughCandleData,
    stopReason,
    statusMessage,
    candlesAvailable: usable.length,
    candlesRequested: requested,
    candlesRemaining,
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

// User example: capital 100, lot 1, payout 2 → 100 invest → 99 → win payout 2 → 101
{
  const { trades, netPnl, liquidated } = runColorFollowStrategy(
    candlesFromColors(["green", "green"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 100 },
  );
  assertClose(trades[0].stake, 1, "stake");
  assertClose(trades[0].payoutReturned, 2, "total payout returned");
  assertClose(trades[0].pnl, 1, "net = payout - lot");
  assertClose(trades[0].balance, 101, "100 → 99 → 101");
  assertClose(netPnl, 1, "net pnl");
  assert(!liquidated, "not liquidated");
}

// Win then loss on capital 100
{
  const { trades } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "red"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 100 },
  );
  assertClose(trades[0].balance, 101, "win balance");
  assertClose(trades[0].pnl, 1, "win net");
  assertClose(trades[1].pnl, -1, "loss net");
  assertClose(trades[1].payoutReturned, 0, "loss payout");
  assertClose(trades[1].balance, 100, "loss balance");
}

// Small capital path: 1 → win 2 → loss 1 → win 2
{
  const { trades, netPnl, liquidated } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "red", "red"]),
    { baseStake: 1, payout: 2, martingale: false, capital: 1 },
  );
  assertClose(trades[0].pnl, 1, "T1 net");
  assertClose(trades[0].balance, 2, "T1 balance");
  assertClose(trades[1].pnl, -1, "T2 net");
  assertClose(trades[1].balance, 1, "T2 balance");
  assertClose(trades[2].pnl, 1, "T3 net");
  assertClose(trades[2].balance, 2, "T3 balance");
  assertClose(netPnl, 1, "net");
  assert(!liquidated, "not liquidated");
}

// Liquidated when martingale lot exceeds remaining balance
{
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
  assertClose(trades[0].balance, 0, "wiped");
  assert(liquidated, "exhausted capital liquidates");
  assert(/liquidated/i.test(liquidatedReason || ""), "liquidated message");
}


// Not enough candle data vs liquidation distinction
{
  const short = candlesFromColors(["green", "green", "red"]);
  const result = runColorFollowStrategy(short, {
    baseStake: 1,
    payout: 2,
    martingale: false,
    capital: 100,
    candlesRequested: 300,
  });
  assert(!result.liquidated, "short history is not liquidation");
  assert(result.trades.length >= 1, "still trades what exists");
  assert(
    result.stopReason === "not_enough_candle_data",
    `expected not_enough_candle_data, got ${result.stopReason}`,
  );
  assert(
    /Not Enough Candle Data/i.test(result.statusMessage || ""),
    `status should say Not Enough Candle Data, got: ${result.statusMessage}`,
  );
}

{
  const colors = [];
  for (let i = 0; i < 40; i += 1) colors.push(i % 2 === 0 ? "green" : "red");
  const result = runColorFollowStrategy(candlesFromColors(colors), {
    baseStake: 1,
    payout: 2,
    martingale: true,
    capital: 100,
    candlesRequested: 300,
  });
  assert(result.liquidated, "should liquidate on martingale");
  assert(
    /still unused|not a data shortage/i.test(result.statusMessage || ""),
    `liquidation should note unused candles, got: ${result.statusMessage}`,
  );
  assert(
    !/^Not Enough Candle Data/i.test(result.statusMessage || ""),
    "liquidation must not be labeled as Not Enough Candle Data",
  );
}

console.log("All capital / payout accounting checks passed.");

