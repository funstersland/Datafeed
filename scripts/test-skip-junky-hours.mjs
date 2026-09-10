/**
 * Skip junky ET hours: no real trades when candle open falls in junk hours.
 */

const JUNKY = new Set([6, 7, 8, 9, 10, 12, 13, 15]);

function etHour(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")?.value) % 24;
}

function candleColor(c) {
  return Number(c.close) >= Number(c.open) ? "green" : "red";
}

function run(candles, { skipJunkyHours = true } = {}) {
  const trades = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (skipJunkyHours && JUNKY.has(etHour(cur.openTimeMs))) {
      trades.push({ skipped: true, openTimeMs: cur.openTimeMs, hour: etHour(cur.openTimeMs) });
      continue;
    }
    const won = candleColor(prev) === candleColor(cur);
    trades.push({
      skipped: false,
      won,
      openTimeMs: cur.openTimeMs,
      hour: etHour(cur.openTimeMs),
    });
  }
  return trades;
}

function c(ms, open, close) {
  return { openTimeMs: ms, open, close, closed: 1 };
}

// 2026-03-09: 10:00 UTC = 6:00 ET (junk), 15:00 UTC = 11:00 ET (ok).
const tJunk = Date.UTC(2026, 2, 9, 10, 0, 0);
const tOk = Date.UTC(2026, 2, 9, 15, 0, 0);
const candles = [
  c(tJunk - 300_000, 100, 110),
  c(tJunk, 110, 100), // 6:00 ET junk → skip
  c(tOk - 300_000, 100, 110), // 10:55 UTC = 6:55 ET still junk → skip
  c(tOk, 110, 100), // 11:00 ET → trade
];

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else console.log("ok:", msg);
}

assert(etHour(tJunk) === 6, `junk candle hour 6 got ${etHour(tJunk)}`);
assert(etHour(tOk) === 11, `ok candle hour 11 got ${etHour(tOk)}`);
assert(!JUNKY.has(11), "11 ET is not a junk hour");

const trades = run(candles, { skipJunkyHours: true });
const skips = trades.filter((t) => t.skipped);
const real = trades.filter((t) => !t.skipped);
assert(skips.length >= 1, `at least one junk skip got ${skips.length}`);
assert(
  skips.every((t) => JUNKY.has(t.hour)),
  "all skips are in junk hours",
);
assert(real.length >= 1, `at least one real trade got ${real.length}`);
assert(
  real.every((t) => !JUNKY.has(t.hour)),
  "no real trades in junk hours",
);
assert(real.some((t) => t.hour === 11), "11 ET trade present");

const off = run(candles, { skipJunkyHours: false });
assert(off.every((t) => !t.skipped), "without checkbox nothing skipped");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("skip junky hours checks passed");
