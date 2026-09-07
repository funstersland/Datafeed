/**
 * Pakistan-hour PnL bucketing with 1Am / 1Pm labels.
 */

const PAKISTAN_TZ = "Asia/Karachi";

function pakistanHour(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PAKISTAN_TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

function formatHourAmPm(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const suffix = h < 12 ? "Am" : "Pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

function summarizePakistanHours(trades, { topN = 3 } = {}) {
  const byHour = [];
  for (let h = 0; h < 24; h += 1) {
    byHour.push({
      hour: h,
      label: formatHourAmPm(h),
      pnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
    });
  }

  for (const t of trades || []) {
    if (t.skipped) continue;
    const hour = pakistanHour(t.openTimeMs);
    const bucket = byHour[hour];
    if (!bucket) continue;
    bucket.pnl += Number(t.pnl) || 0;
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    else bucket.losses += 1;
  }

  const active = byHour.filter((b) => b.trades > 0);
  const byPnlDesc = [...active].sort((a, b) => b.pnl - a.pnl || a.hour - b.hour);
  const byPnlAsc = [...active].sort((a, b) => a.pnl - b.pnl || a.hour - b.hour);

  return {
    byHour,
    topProfitHours: byPnlDesc.filter((b) => b.pnl > 0).slice(0, topN),
    topLossHours: byPnlAsc.filter((b) => b.pnl < 0).slice(0, topN),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(formatHourAmPm(0) === "12Am", "0 → 12Am");
assert(formatHourAmPm(1) === "1Am", "1 → 1Am");
assert(formatHourAmPm(11) === "11Am", "11 → 11Am");
assert(formatHourAmPm(12) === "12Pm", "12 → 12Pm");
assert(formatHourAmPm(13) === "1Pm", "13 → 1Pm");
assert(formatHourAmPm(23) === "11Pm", "23 → 11Pm");

// 2024-01-01 09:00 UTC = 2Pm PKT; 10:00 UTC = 3Pm; 11:00 UTC = 4Pm
const t14 = Date.UTC(2024, 0, 1, 9, 0, 0);
const t15 = Date.UTC(2024, 0, 1, 10, 0, 0);
const t16 = Date.UTC(2024, 0, 1, 11, 0, 0);

assert(pakistanHour(t14) === 14, `expected 14, got ${pakistanHour(t14)}`);
assert(formatHourAmPm(pakistanHour(t14)) === "2Pm", "14 PKT label");

const trades = [
  { openTimeMs: t14, pnl: 40, won: true, skipped: false },
  { openTimeMs: t14, pnl: 20, won: true, skipped: false },
  { openTimeMs: t15, pnl: -10, won: false, skipped: false },
  { openTimeMs: t15, pnl: -30, won: false, skipped: false },
  { openTimeMs: t16, pnl: 5, won: true, skipped: false },
  { openTimeMs: t16, pnl: -100, won: false, skipped: true },
];

const summary = summarizePakistanHours(trades);
assert(summary.byHour.length === 24, "24 hour buckets");
assert(summary.topProfitHours[0].label === "2Pm", "top profit 2Pm");
assert(summary.topProfitHours[0].pnl === 60, "2Pm pnl 60");
assert(summary.topLossHours[0].label === "3Pm", "top loss 3Pm");
assert(summary.topLossHours[0].pnl === -40, "3Pm pnl -40");

console.log("ok: pakistan hours Am/Pm");
