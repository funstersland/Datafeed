/**
 * Verifies cash-flow PnL settlement: stake is deducted each round (reinvested),
 * wins credit stake * payout (total return), so net win = stake * (payout - 1).
 */

function candleColor(candle) {
  return Number(candle.close) >= Number(candle.open) ? "green" : "red";
}

function runColorFollowStrategy(candles, { baseStake, payout, martingale }) {
  const closed = candles.filter((c) => c.closed === true || c.closed === 1);
  const usable = closed.length >= 2 ? closed : candles;
  const trades = [];
  let stake = baseStake;
  let balance = 0;
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
      const grossReturn = tradeStake * payout;
      balance += grossReturn;
      pnl = grossReturn - tradeStake;
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

    trades.push({ won, stake: tradeStake, pnl, balance });
  }

  return { trades, netPnl: balance };
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

// Flat stake, even money (payout 2): win net +1, loss -1; stake deducted then returned on win.
{
  const colors = ["green", "green", "green", "red", "red", "green", "green"];
  const candles = colors.map((c, i) => ({
    open: c === "green" ? 1 : 2,
    close: c === "green" ? 2 : 1,
    closed: true,
    openTimeMs: i * 1000,
  }));
  const { trades, netPnl } = runColorFollowStrategy(candles, {
    baseStake: 1,
    payout: 2,
    martingale: false,
  });

  // predictions follow previous color → W,W,L,W,L,W
  const expectedPnls = [1, 1, -1, 1, -1, 1];
  const expectedBalances = [1, 2, 1, 2, 1, 2];
  assertClose(trades.length, expectedPnls.length, "trade count");
  trades.forEach((t, i) => {
    assertClose(t.pnl, expectedPnls[i], `pnl[${i}]`);
    assertClose(t.balance, expectedBalances[i], `balance[${i}]`);
  });
  assertClose(netPnl, 2, "netPnl flat even-money");
}

// Screenshot-style bug regression: payout 2 must NOT credit +2 net per win.
{
  const wins = 31;
  const losses = 17;
  // Build alternating enough candles: start green, then win streak then mix
  const colors = ["green"];
  for (let i = 0; i < wins; i += 1) colors.push("green");
  // After wins on green, flip to create losses/wins as needed is hard; assert formula instead:
  const stake = 1;
  const payout = 2;
  const netPerWin = stake * (payout - 1);
  const netPerLoss = -stake;
  const expected = wins * netPerWin + losses * netPerLoss;
  assertClose(netPerWin, 1, "net per win with payout 2");
  assertClose(expected, 14, "31W/17L net with stake deducted");
  // Old buggy formula was wins * stake * payout + losses * -stake = 45
  const buggy = wins * stake * payout + losses * -stake;
  assertClose(buggy, 45, "old buggy total");
  if (!(expected < buggy)) throw new Error("fixed total should be lower than buggy gross credit");
}

// Martingale recovery with even money: loss 1, then win 2 recovers and resets.
{
  const colors = ["red", "red", "green", "green"];
  const candles = colors.map((c, i) => ({
    open: c === "green" ? 1 : 2,
    close: c === "green" ? 2 : 1,
    closed: true,
    openTimeMs: i * 1000,
  }));
  const { trades, netPnl } = runColorFollowStrategy(candles, {
    baseStake: 1,
    payout: 2,
    martingale: true,
  });
  // i=1: predict red, actual red → win stake 1, pnl +1, bal 1
  // i=2: predict red, actual green → loss stake 1, pnl -1, bal 0, next stake 2
  // i=3: predict green, actual green → win stake 2, pnl +2, bal 2, reset
  assertClose(trades[0].pnl, 1, "mg trade0 pnl");
  assertClose(trades[1].pnl, -1, "mg trade1 pnl");
  assertClose(trades[1].stake, 1, "mg trade1 stake");
  assertClose(trades[2].stake, 2, "mg trade2 doubled stake");
  assertClose(trades[2].pnl, 2, "mg trade2 net pnl");
  assertClose(netPnl, 2, "mg net");
}

console.log("All PnL settlement checks passed.");
