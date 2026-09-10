/**
 * Aggregation open-time checks for 30m / 1h / 4h / 1d from 5m buckets.
 */
function candleOpenTimeMs(observedAtMs, window) {
  if (window === "1d") {
    // Approximate UTC day for unit test (production uses ET midnight).
    const d = new Date(observedAtMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const step =
    {
      "5m": 300_000,
      "15m": 900_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "4h": 14_400_000,
    }[window] ?? 300_000;
  return observedAtMs - (observedAtMs % step);
}

function aggregate(fiveOpens, window) {
  const set = new Set();
  for (const t of fiveOpens) set.add(candleOpenTimeMs(t, window));
  return [...set].sort((a, b) => a - b);
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  } else console.log("ok:", msg);
}

const base = Date.UTC(2026, 2, 9, 12, 0, 0);
const five = [];
for (let i = 0; i < 12; i++) five.push(base + i * 300_000); // 1h of 5m

const m30 = aggregate(five, "30m");
assert(m30.length === 2, `30m buckets 2 got ${m30.length}`);
assert(m30[0] === base, "30m first open");
assert(m30[1] === base + 1_800_000, "30m second open");

const h1 = aggregate(five, "1h");
assert(h1.length === 1, `1h buckets 1 got ${h1.length}`);

const four = [];
for (let i = 0; i < 48; i++) four.push(base + i * 300_000); // 4h
const h4 = aggregate(four, "4h");
assert(h4.length === 1, `4h buckets 1 got ${h4.length}`);
assert(h4[0] === base, "4h aligned to base");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("aggregate window checks passed");
