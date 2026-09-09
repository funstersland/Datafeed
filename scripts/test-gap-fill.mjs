/**
 * Unit checks for candle gap open-time alignment / missing detection helpers.
 * Mirrors src/candles/gapFill.ts expectedOpenTimes logic.
 */
function stepMs(window) {
  return window === "5m" ? 300_000 : 900_000;
}

function alignOpenMs(ms, window) {
  const step = stepMs(window);
  return ms - (ms % step);
}

function expectedOpenTimes(window, fromOpenMs, throughMs) {
  const step = stepMs(window);
  const start = alignOpenMs(fromOpenMs, window);
  const end = alignOpenMs(throughMs, window);
  const out = [];
  for (let t = start; t <= end; t += step) out.push(t);
  return out;
}

function findMissing(expected, existingSet) {
  return expected.filter((t) => !existingSet.has(t));
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else {
    console.log("ok:", msg);
  }
}

const base = Date.UTC(2026, 2, 9, 12, 0, 0); // aligned 5m
const expected5 = expectedOpenTimes("5m", base, base + 25 * 60_000);
assert(expected5.length === 6, `5m expected 6 buckets got ${expected5.length}`);
assert(expected5[0] === base, "5m starts at base");
assert(expected5[1] === base + 300_000, "5m second bucket +5m");

const existing = new Set([base, base + 600_000, base + 1_200_000]);
const missing = findMissing(expected5, existing);
assert(missing.length === 3, `missing count 3 got ${missing.length}`);
assert(
  missing.includes(base + 300_000) &&
    missing.includes(base + 900_000) &&
    missing.includes(base + 1_500_000),
  "missing open times match skipped buckets",
);

const expected15 = expectedOpenTimes("15m", base, base + 45 * 60_000);
assert(expected15.length === 4, `15m expected 4 got ${expected15.length}`);

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("all gap-fill helper checks passed");
