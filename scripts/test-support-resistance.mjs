/**
 * Support/resistance zones from swing pivots + clustering.
 */

function findSupportResistanceLevels(
  candles,
  { pivot = 3, maxLevels = 2, clusterPct = 0.0045 } = {},
) {
  if (!candles?.length || candles.length < pivot * 2 + 1) {
    return { support: [], resistance: [] };
  }

  const highs = [];
  const lows = [];
  for (let i = pivot; i < candles.length - pivot; i += 1) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    if (![h, l].every(Number.isFinite)) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= pivot; j += 1) {
      if (Number(candles[i - j].high) >= h || Number(candles[i + j].high) >= h) {
        isHigh = false;
      }
      if (Number(candles[i - j].low) <= l || Number(candles[i + j].low) <= l) {
        isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(h);
    if (isLow) lows.push(l);
  }

  const lastClose = Number(candles[candles.length - 1].close);
  const clusterTol =
    Number.isFinite(lastClose) && lastClose > 0 ? lastClose * clusterPct : 0;
  const minHalfBand =
    Number.isFinite(lastClose) && lastClose > 0 ? lastClose * 0.0012 : 0;

  const clusterLevels = (prices, prefer) => {
    if (!prices.length) return [];
    const sorted = [...prices].sort((a, b) => a - b);
    const clusters = [];
    let bucket = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      const p = sorted[i];
      const center = bucket.reduce((s, x) => s + x, 0) / bucket.length;
      if (Math.abs(p - center) <= clusterTol) bucket.push(p);
      else {
        clusters.push(bucket);
        bucket = [p];
      }
    }
    clusters.push(bucket);

    return clusters
      .map((bucketPrices) => {
        const min = Math.min(...bucketPrices);
        const max = Math.max(...bucketPrices);
        const avg =
          bucketPrices.reduce((s, x) => s + x, 0) / bucketPrices.length;
        const half = Math.max((max - min) / 2, minHalfBand);
        return {
          price: avg,
          top: avg + half,
          bottom: avg - half,
          touches: bucketPrices.length,
        };
      })
      .sort((a, b) => {
        if (b.touches !== a.touches) return b.touches - a.touches;
        return Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose);
      })
      .filter((lvl) =>
        prefer === "below" ? lvl.price <= lastClose : lvl.price >= lastClose,
      )
      .slice(0, maxLevels);
  };

  return {
    support: clusterLevels(lows, "below"),
    resistance: clusterLevels(highs, "above"),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const candles = [];
for (let i = 0; i < 40; i += 1) {
  const base = i < 20 ? 100 - i : 80 + (i - 20);
  candles.push({
    time: i,
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + (i % 2 === 0 ? 1 : -1),
  });
}
candles[20] = { time: 20, open: 78, high: 79, low: 70, close: 78 };
candles[5] = { time: 5, open: 100, high: 120, low: 99, close: 100 };
candles[35] = { time: 35, open: 100, high: 118, low: 99, close: 100 };

const levels = findSupportResistanceLevels(candles, {
  pivot: 2,
  maxLevels: 2,
  clusterPct: 0.02,
});

assert(levels.support.length >= 1, "expected support zone(s)");
assert(levels.resistance.length >= 1, "expected resistance zone(s)");
assert(
  levels.support.every((z) => z.bottom < z.price && z.top > z.price),
  "support has band around price",
);
assert(
  levels.resistance.every((z) => z.bottom < z.price && z.top > z.price),
  "resistance has band around price",
);
assert(
  levels.support.every((z) => z.price <= candles[candles.length - 1].close + 1e-9),
  "support at/below price",
);
assert(
  levels.resistance.every((z) => z.price >= candles[candles.length - 1].close - 1e-9),
  "resistance at/above price",
);

console.log("ok: support/resistance zones", levels);
