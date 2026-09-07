/**
 * Wallet settlement: starting balance funds the first stake.
 * Each round: balance -= stake; on win balance += stake * payout (PnL shows that credit).
 *
 * User example (start 1, stake 1, payout 2):
 *   win  → pnl +2, balance 2
 *   loss → pnl -1, balance 1
 *   win  → pnl +2, balance 2  (NOT 3)
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(
  candles,
  { baseStake, payout, martingale, startingBalance },
) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const trades = [];
  let stake = baseStake;
  const startBal = Number.isFinite(startingBalance)
    ? startingBalance
    : baseStake;
  let balance = startBal;
  let unrecoveredLoss = 0;

  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const predicted = candleColor(prev);
    const actual = candleColor(cur);
    const won = predicted === actual;
    const tradeStake = stake;
    let pnl = 0;

    balance -= tradeStake;

    if (won) {
      const winCredit = tradeStake * payout;
      balance += winCredit;
      pnl = winCredit;
      if (martingale) {
        const netGain = winCredit - tradeStake;
        unrecoveredLoss = Math.max(0, unrecoveredLoss - netGain);
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

    trades.push({ won, stake: tradeStake, pnl, balance });
  }

  return {
    trades,
    netPnl: balance - startBal,
    endingBalance: balance,
    startingBalance: startBal,
  };
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function candlesFromColors(colors) {
  return colors.map((c, i) => ({
    open: c === "green" ? 1 : 2,
    close: c === "green" ? 2 : 1,
    closed: true,
    openTimeMs: i * 1000,
  }));
}

// Exact user example: win, loss, win → balances 2, 1, 2 (never 3)
{
  // colors: green, green (win), red (loss), red (win)
  const { trades, netPnl, endingBalance } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "red", "red"]),
    { baseStake: 1, payout: 2, martingale: false, startingBalance: 1 },
  );
  assertClose(trades.length, 3, "user example trade count");
  assertClose(trades[0].pnl, 2, "T1 pnl");
  assertClose(trades[0].balance, 2, "T1 balance");
  assertClose(trades[1].pnl, -1, "T2 pnl");
  assertClose(trades[1].balance, 1, "T2 balance");
  assertClose(trades[2].pnl, 2, "T3 pnl");
  assertClose(trades[2].balance, 2, "T3 balance must be 2 not 3");
  assertClose(endingBalance, 2, "ending balance");
  assertClose(netPnl, 1, "net pnl vs start");
}

// Buggy old formula would produce balance 3 on third row
{
  let buggy = 0;
  const pnls = [2, -1, 2];
  const buggyBalances = pnls.map((p) => {
    buggy += p;
    return buggy;
  });
  assertClose(buggyBalances[2], 3, "old buggy third balance");
}

// Flat series still consistent
{
  const { trades, netPnl } = runColorFollowStrategy(
    candlesFromColors(["green", "green", "green", "red", "red", "green", "green"]),
    { baseStake: 1, payout: 2, martingale: false, startingBalance: 1 },
  );
  // W,W,L,W,L,W
  const expectedPnls = [2, 2, -1, 2, -1, 2];
  const expectedBalances = [2, 3, 2, 3, 2, 3];
  trades.forEach((t, i) => {
    assertClose(t.pnl, expectedPnls[i], `flat pnl[${i}]`);
    assertClose(t.balance, expectedBalances[i], `flat bal[${i}]`);
  });
  assertClose(netPnl, 2, "flat net");
}

// Martingale: unrecovered uses net gain (credit - stake)
{
  const { trades, netPnl } = runColorFollowStrategy(
    candlesFromColors(["red", "red", "green", "green"]),
    { baseStake: 1, payout: 2, martingale: true, startingBalance: 1 },
  );
  // W stake1 credit2 bal2; L stake1 bal1 next2; W stake2 credit4 bal 1-2+4=3
  assertClose(trades[0].pnl, 2, "mg0 pnl");
  assertClose(trades[0].balance, 2, "mg0 bal");
  assertClose(trades[1].pnl, -1, "mg1 pnl");
  assertClose(trades[1].balance, 1, "mg1 bal");
  assertClose(trades[2].stake, 2, "mg2 stake");
  assertClose(trades[2].pnl, 4, "mg2 pnl credit");
  assertClose(trades[2].balance, 3, "mg2 bal");
  assertClose(netPnl, 2, "mg net");
}

console.log("All PnL settlement checks passed.");
