/**
 * Pakistan-hour PnL bucketing for top profit / top loss hours.
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

function formatPakistanHourRange(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const next = (h + 1) % 24;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:00–${pad(next)}:00 PKT`;
}

function summarizePakistanHours(trades, { topN = 3 } = {}) {
  const byHour = new Map();
  for (let h = 0; h < 24; h += 1) {
    byHour.set(h, {
      hour: h,
      label: formatPakistanHourRange(h),
      pnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
    });
  }

  for (const t of trades || []) {
    if (t.skipped) continue;
    const hour = pakistanHour(t.openTimeMs);
    const bucket = byHour.get(hour);
    if (!bucket) continue;
    bucket.pnl += Number(t.pnl) || 0;
    bucket.trades += 1;
    if (t.won) bucket.wins += 1;
    else bucket.losses += 1;
  }

  const active = [...byHour.values()].filter((b) => b.trades > 0);
  const byPnlDesc = [...active].sort((a, b) => b.pnl - a.pnl || a.hour - b.hour);
  const byPnlAsc = [...active].sort((a, b) => a.pnl - b.pnl || a.hour - b.hour);

  return {
    topProfitHours: byPnlDesc.filter((b) => b.pnl > 0).slice(0, topN),
    topLossHours: byPnlAsc.filter((b) => b.pnl < 0).slice(0, topN),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 2024-01-01 09:00 UTC = 14:00 PKT; 10:00 UTC = 15:00 PKT; 11:00 UTC = 16:00 PKT
const t14 = Date.UTC(2024, 0, 1, 9, 0, 0);
const t15 = Date.UTC(2024, 0, 1, 10, 0, 0);
const t16 = Date.UTC(2024, 0, 1, 11, 0, 0);

assert(pakistanHour(t14) === 14, `expected 14 PKT, got ${pakistanHour(t14)}`);
assert(pakistanHour(t15) === 15, `expected 15 PKT, got ${pakistanHour(t15)}`);
assert(pakistanHour(t16) === 16, `expected 16 PKT, got ${pakistanHour(t16)}`);
assert(
  formatPakistanHourRange(14) === "14:00–15:00 PKT",
  "hour range label",
);

const trades = [
  { openTimeMs: t14, pnl: 40, won: true, skipped: false },
  { openTimeMs: t14, pnl: 20, won: true, skipped: false },
  { openTimeMs: t15, pnl: -10, won: false, skipped: false },
  { openTimeMs: t15, pnl: -30, won: false, skipped: false },
  { openTimeMs: t16, pnl: 5, won: true, skipped: false },
  { openTimeMs: t16, pnl: -100, won: false, skipped: true }, // ignored
];

const summary = summarizePakistanHours(trades);
assert(summary.topProfitHours[0].hour === 14, "top profit is 14 PKT");
assert(summary.topProfitHours[0].pnl === 60, "14 PKT pnl 60");
assert(summary.topProfitHours[1].hour === 16, "2nd profit is 16 PKT");
assert(summary.topLossHours[0].hour === 15, "top loss is 15 PKT");
assert(summary.topLossHours[0].pnl === -40, "15 PKT pnl -40");
assert(summary.topLossHours.length === 1, "only one loss hour");

console.log("ok: pakistan hour bucketing");
