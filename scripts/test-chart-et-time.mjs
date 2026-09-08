/**
 * Chart timestamps should match Polymarket ET market labels.
 */

const POLYMARKET_TZ = "America/New_York";

function utcSecToEtChartTime(utcSec) {
  const d = new Date(Number(utcSec) * 1000);
  if (!Number.isFinite(d.getTime())) return utcSec;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: POLYMARKET_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return Math.floor(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second),
    ) / 1000,
  );
}

function formatEtLabel(msOrSec, { withDate = false } = {}) {
  const ms = Number(msOrSec) > 1e12 ? Number(msOrSec) : Number(msOrSec) * 1000;
  if (!Number.isFinite(ms)) return "—";
  const opts = {
    timeZone: POLYMARKET_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (withDate) {
    opts.month = "short";
    opts.day = "numeric";
  }
  return `${new Intl.DateTimeFormat("en-US", opts).format(new Date(ms))} ET`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Polymarket: btc-updown-5m-1788871500 = 8:45AM-8:50AM ET
const openUnix = 1788871500;
const shifted = utcSecToEtChartTime(openUnix);
const shiftedDate = new Date(shifted * 1000);

assert(shiftedDate.getUTCHours() === 8, `expected UTC hour 8 after shift, got ${shiftedDate.getUTCHours()}`);
assert(shiftedDate.getUTCMinutes() === 45, `expected minute 45, got ${shiftedDate.getUTCMinutes()}`);

const label = formatEtLabel(openUnix * 1000);
assert(/8:45\s*AM\s*ET/i.test(label), `label should be 8:45 AM ET, got ${label}`);

// DST-safe-ish: another known offset winter vs summer not required here;
// just ensure monotonic ordering preserved for consecutive 5m candles.
const a = utcSecToEtChartTime(openUnix);
const b = utcSecToEtChartTime(openUnix + 300);
assert(b > a, "shifted times stay ordered");
assert(b - a === 300, `spacing preserved, got ${b - a}`);

console.log("ok: chart ET timestamps", { openUnix, shifted, label });
