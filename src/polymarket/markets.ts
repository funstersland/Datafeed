import {
  PAIR_META,
  POLYMARKET,
  TWAP_LOOKBACK_SECONDS,
  type Pair,
  type Window,
  WINDOWS,
} from "../config.js";
import { upsertMarketMeta } from "../db.js";

type GammaEvent = {
  slug?: string;
  title?: string;
  seriesSlug?: string;
  resolutionSource?: string;
  closed?: boolean;
  markets?: Array<{
    resolutionSource?: string;
    eventStartTime?: string;
    endDate?: string;
    cryptoMarketConfig?: {
      id?: string;
      asset?: string;
      duration?: string;
      twapEnabled?: boolean;
      twapLookbackSeconds?: number;
    };
  }>;
};

function floorUnix(seconds: number, step: number): number {
  return seconds - (seconds % step);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Datafeed/1.0 (Polymarket-only)",
    },
  });
  if (!res.ok) {
    throw new Error(`Polymarket HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

function windowToSlugParts(window: Window): {
  short: string;
  series: string;
  seconds: number | null;
  variant: string;
} {
  switch (window) {
    case "5m":
      return {
        short: "5m",
        series: "5m",
        seconds: 300,
        variant: "fiveminute",
      };
    case "15m":
      return {
        short: "15m",
        series: "15m",
        seconds: 900,
        variant: "fifteen",
      };
    case "1h":
      return {
        short: "1h",
        series: "hourly",
        seconds: 3600,
        variant: "hourly",
      };
    case "1d":
      return {
        short: "1d",
        series: "daily",
        seconds: null,
        variant: "daily",
      };
  }
}

async function loadBySlug(slug: string): Promise<GammaEvent | null> {
  try {
    const data = await fetchJson<GammaEvent[]>(
      `${POLYMARKET.gamma}/events?slug=${encodeURIComponent(slug)}`,
    );
    return data[0] ?? null;
  } catch {
    return null;
  }
}

async function discoverShortWindow(
  pair: Pair,
  window: "5m" | "15m",
): Promise<GammaEvent | null> {
  const now = Math.floor(Date.now() / 1000);
  const step = window === "5m" ? 300 : 900;
  const asset = PAIR_META[pair].slugAsset;
  for (let i = 0; i < 6; i++) {
    const ts = floorUnix(now, step) - i * step;
    const slug = `${asset}-updown-${window}-${ts}`;
    const event = await loadBySlug(slug);
    if (event) return event;
  }
  return null;
}

async function discoverHourlyOrDaily(
  pair: Pair,
  window: "1h" | "1d",
): Promise<GammaEvent | null> {
  const et = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = months[et.getMonth()];
  const day = et.getDate();
  const year = et.getFullYear();
  const names = [
    PAIR_META[pair].displayName.toLowerCase().replace(/\s+/g, ""),
    PAIR_META[pair].displayName.toLowerCase(),
    PAIR_META[pair].slugAsset,
  ];
  // Prefer exact current ET slug over stale series listings.
  if (window === "1d") {
    for (const name of [...new Set(names)]) {
      for (const slug of [
        `${name}-up-or-down-on-${month}-${day}-${year}`,
        `${name}-up-or-down-on-${month}-${day}`,
      ]) {
        const event = await loadBySlug(slug);
        if (event) return event;
      }
    }
  } else {
    const h = et.getHours();
    const ampm = h < 12 ? "am" : "pm";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    for (const name of [...new Set(names)]) {
      const slug = `${name}-up-or-down-${month}-${day}-${h12}${ampm}-et`;
      const event = await loadBySlug(slug);
      if (event) return event;
    }
  }

  const seriesSlug = `${PAIR_META[pair].slugAsset}-up-or-down-${window === "1h" ? "hourly" : "daily"}`;
  try {
    const series = await fetchJson<Array<{ id?: number | string }>>(
      `${POLYMARKET.gamma}/series?slug=${encodeURIComponent(seriesSlug)}`,
    );
    const id = series[0]?.id;
    if (id != null) {
      const events = await fetchJson<GammaEvent[]>(
        `${POLYMARKET.gamma}/events?series_id=${id}&limit=20`,
      );
      const open = events.find(
        (e) =>
          !e.closed &&
          (e.slug ?? "").toLowerCase().includes(month) &&
          (e.slug ?? "").includes(String(day)),
      );
      if (open) return open;
      const anyOpen = events.find((e) => !e.closed);
      if (anyOpen) return anyOpen;
      if (events[0]) return events[0];
    }
  } catch {
    // fall through
  }
  return null;
}

export async function refreshMarketMetadata(): Promise<void> {
  const now = Date.now();
  for (const pair of Object.keys(PAIR_META) as Pair[]) {
    for (const window of WINDOWS) {
      let event: GammaEvent | null = null;
      if (window === "5m" || window === "15m") {
        event = await discoverShortWindow(pair, window);
      } else {
        event = await discoverHourlyOrDaily(pair, window);
      }

      const market = event?.markets?.[0];
      const cfg = market?.cryptoMarketConfig;
      const resolution =
        event?.resolutionSource ||
        market?.resolutionSource ||
        (cfg?.twapEnabled
          ? `https://data.chain.link/streams/${PAIR_META[pair].slugAsset}-usd-twap-60s-streams`
          : null);

      upsertMarketMeta({
        pair,
        window,
        seriesSlug:
          event?.seriesSlug ??
          `${PAIR_META[pair].slugAsset}-up-or-down-${windowToSlugParts(window).series}`,
        marketSlug: event?.slug ?? null,
        title: event?.title ?? null,
        resolutionSource: resolution,
        twapEnabled: cfg?.twapEnabled ? 1 : window === "5m" || window === "15m" ? 1 : 0,
        twapLookbackSeconds:
          cfg?.twapLookbackSeconds ??
          (window === "5m" || window === "15m" ? TWAP_LOOKBACK_SECONDS : null),
        cryptoMarketConfigId: cfg?.id ?? null,
        rawJson: event ? JSON.stringify(event) : null,
        updatedAtMs: now,
      });
    }
  }
}

export { windowToSlugParts };
