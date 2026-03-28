// ─── Historical Data API ─────────────────────────────────────
// Fetches historical trades/prices for retroactive spike analysis.
// Kalshi: real trade data at per-trade granularity (public, no auth)
// Polymarket: price history via CLOB API (limited for resolved markets)

import { classifyCategory, LEAK_PROBS } from "./categories.js";
import { computeSuspicion, robustZ } from "../scoring.js";

/**
 * Format a timestamp for chart x-axis labels. Includes date + time.
 * e.g. "Mar 8 14:23"
 */
function fmtBinTime(ts) {
  const d = new Date(ts);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

const KALSHI_BASE = "/api/kalshi";
const POLY_BASE = "/api/poly";
const CLOB_BASE = "/api/clob";
const FETCH_TIMEOUT = 15000;

// ─── Market Search ──────────────────────────────────────────

let _kalshiEventCache = null;
let _kalshiCacheTs = 0;
const CACHE_TTL = 300000; // 5 min
let _kalshiSettledCache = null;
let _kalshiSettledCacheTs = 0;

export async function searchMarkets(keyword) {
  if (!keyword || keyword.length < 2) return [];
  const kw = keyword.toLowerCase();
  // Kalshi only — Polymarket has very limited history for resolved markets
  return searchKalshi(kw);
}

async function fetchKalshiEvents(status, cache, cacheTs) {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) return cache.data;
  try {
    const res = await fetch(`${KALSHI_BASE}/events?limit=200&status=${status}&with_nested_markets=true`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    cache.data = data.events || [];
    cache.ts = Date.now();
    return cache.data;
  } catch { return []; }
}

const _openCache = { data: null, ts: 0 };
const _settledCache = { data: null, ts: 0 };

async function searchKalshi(kw) {
  try {
    // Only fetch settled events — history tab is for retroactive analysis of resolved markets
    const settledEvents = await fetchKalshiEvents("settled", _settledCache);
    const allEvents = settledEvents;

    const results = [];
    for (const ev of allEvents) {
      const evTitle = ev.title || "";
      const evMatch = evTitle.toLowerCase().includes(kw);
      const markets = ev.markets || [];
      for (const m of markets) {
        const title = m.title || evTitle || "";
        const sub = m.yes_sub_title || m.no_sub_title || "";
        const searchable = `${title} ${sub} ${m.ticker || ""}`.toLowerCase();
        if (evMatch || searchable.includes(kw)) {
          // Build a descriptive name: "Event Title — Candidate/Subtitle"
          const displayName = sub && sub !== title
            ? `${evTitle || title} — ${sub.slice(0, 40)}`
            : (title.length < 100 ? title : evTitle || title.slice(0, 80));
          results.push({
            id: m.ticker,
            venue: "Kalshi",
            name: displayName,
            ticker: m.ticker,
            eventTicker: ev.ticker,
            category: classifyCategory(`${title} ${ev.category || ""}`),
            status: m.status || "unknown",
            endDate: m.expiration_time || m.close_time,
            volume: parseFloat(m.volume_fp) || 0,
            result: m.result || null,
            closeTime: m.close_time || null,
            settlementTs: m.settlement_ts || null,
          });
        }
        if (results.length >= 50) break;
      }
      if (results.length >= 50) break;
    }
    // Sort by volume so highest-activity markets appear first
    results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    return results.slice(0, 30);
  } catch (err) {
    console.error("[History] Kalshi search failed:", err);
    return [];
  }
}

async function searchPoly(kw) {
  try {
    // Only fetch closed markets — history tab is for retroactive analysis of resolved markets
    const closedRes = await fetch(`${POLY_BASE}/markets?limit=100&closed=true&order=volume24hr&ascending=false`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const closedData = closedRes.ok ? await closedRes.json() : [];
    const markets = Array.isArray(closedData) ? closedData : [];

    return markets
      .filter((m) => (m.question || "").toLowerCase().includes(kw) || (m.slug || "").toLowerCase().includes(kw))
      .slice(0, 20)
      .map((m) => {
        let tokenIds;
        try { tokenIds = JSON.parse(m.clobTokenIds || "[]"); } catch { tokenIds = []; }
        return {
          id: `poly-${m.id}`,
          venue: "Polymarket",
          name: m.question || m.slug,
          marketId: m.id,
          tokenId: tokenIds[0] || null,
          conditionId: m.conditionId,
          category: classifyCategory(m.question + " " + (m.slug || ""), m.events),
          status: "closed",
          endDate: m.endDate,
        };
      });
  } catch (err) {
    console.error("[History] Polymarket search failed:", err);
    return [];
  }
}

// ─── Historical Trade Fetching ──────────────────────────────

/**
 * Fetch Kalshi trades for a ticker within a time range.
 * Paginates automatically (up to 10 pages).
 */
export async function fetchKalshiTrades(ticker, startTs, endTs) {
  const trades = [];
  let cursor = null;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      ticker,
      limit: "1000",
      min_ts: String(Math.floor(startTs / 1000)),
      max_ts: String(Math.floor(endTs / 1000)),
    });
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await fetch(`${KALSHI_BASE}/markets/trades?${params}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.trades || [];
      trades.push(...batch);
      cursor = data.cursor;
      if (!cursor || batch.length < 1000) break;
    } catch (err) {
      console.error(`[History] Kalshi trades page ${page} failed:`, err);
      break;
    }
  }

  return trades.map((t) => ({
    ts: new Date(t.created_time).getTime(),
    volume: parseFloat(t.count_fp) || 0,
    price: parseFloat(t.yes_price_dollars) || 0,
    side: t.taker_side,
  }));
}

/**
 * Fetch Polymarket price history for a token.
 * Returns price points — volume is approximated from price velocity.
 */
export async function fetchPolyPriceHistory(tokenId, startTs, endTs) {
  if (!tokenId) return [];
  try {
    const params = new URLSearchParams({
      market: tokenId,
      startTs: String(Math.floor(startTs / 1000)),
      endTs: String(Math.floor(endTs / 1000)),
      fidelity: "1", // 1-minute
    });
    const res = await fetch(`${CLOB_BASE}/prices-history?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const history = data.history || [];
    return history.map((p) => ({
      ts: (p.t || 0) * 1000,
      price: parseFloat(p.p) || 0,
    }));
  } catch (err) {
    console.error("[History] Polymarket price history failed:", err);
    return [];
  }
}

// ─── Binning ────────────────────────────────────────────────

/**
 * Bin raw Kalshi trades into per-minute volume + avg price buckets.
 */
export function binKalshiTrades(trades, startTs, endTs) {
  const intervalMs = 60000;
  const binCount = Math.ceil((endTs - startTs) / intervalMs);
  const bins = [];

  for (let i = 0; i < binCount; i++) {
    bins.push({
      ts: startTs + i * intervalMs,
      volume: 0,
      yesVolume: 0,
      noVolume: 0,
      priceSum: 0,
      tradeCount: 0,
    });
  }

  for (const t of trades) {
    const idx = Math.floor((t.ts - startTs) / intervalMs);
    if (idx >= 0 && idx < binCount) {
      bins[idx].volume += t.volume;
      if (t.side === "yes") bins[idx].yesVolume += t.volume;
      else bins[idx].noVolume += t.volume;
      bins[idx].priceSum += t.price * t.volume;
      bins[idx].tradeCount += 1;
    }
  }

  // Forward-fill prices so empty bins carry the last traded price
  // instead of null (which causes connectNulls to draw misleading diagonals)
  let lastPrice = null;
  return bins.map((b) => {
    if (b.tradeCount > 0) lastPrice = b.priceSum / b.volume;
    return {
      ts: b.ts,
      volume: Math.round(b.volume),
      yesVol: Math.round(b.yesVolume),
      noVol: Math.round(b.noVolume),
      price: lastPrice,
      time: fmtBinTime(b.ts),
    };
  });
}

/**
 * Convert Polymarket price points to binned data.
 * Uses price velocity (absolute change per interval) as a volume proxy.
 */
export function binPolyPrices(pricePoints, startTs, endTs) {
  if (pricePoints.length < 2) return [];
  const intervalMs = 60000;
  const binCount = Math.ceil((endTs - startTs) / intervalMs);
  const bins = [];

  // Index price points by bin
  const priceByBin = new Map();
  for (const p of pricePoints) {
    const idx = Math.floor((p.ts - startTs) / intervalMs);
    if (idx >= 0 && idx < binCount) {
      priceByBin.set(idx, p.price);
    }
  }

  let lastPrice = pricePoints[0].price;
  for (let i = 0; i < binCount; i++) {
    const price = priceByBin.get(i) ?? lastPrice;
    const velocity = Math.abs(price - lastPrice) * 10000; // scale up for visibility
    bins.push({
      ts: startTs + i * intervalMs,
      volume: Math.round(velocity),
      price,
      time: fmtBinTime(startTs + i * intervalMs),
    });
    lastPrice = price;
  }

  return bins;
}

// ─── Retroactive Scoring ────────────────────────────────────

/**
 * Slide a 90-bin window across the timeline, computing suspicion at each point.
 * Returns enriched bins with suspicion scores.
 */
export function computeRetroactiveScores(bins, marketMeta) {
  const windowSize = 90;
  const leakProb = LEAK_PROBS[marketMeta.category] || 0.5;

  return bins.map((bin, i) => {
    if (i < windowSize) {
      return { ...bin, suspicion: 0, zScore: 0 };
    }

    const window = bins.slice(i - windowSize, i).map((b) => b.volume);
    const currentVol = bin.volume;
    const z = robustZ(currentVol, window);

    // Build a synthetic market object for computeSuspicion
    const prevPrice = bins[i - 1]?.price ?? bin.price;
    const priceChange = (bin.price || 0) - (prevPrice || 0);
    // Heuristic: if there's a big price move AND volume, news likely drove it
    // Only flag "no news" when volume spikes WITHOUT a corresponding price move
    const hasNews = Math.abs(priceChange) > 0.02;
    const syntheticMarket = {
      bins: [...window, currentVol],
      priceChange,
      leakProb,
      hasRecentNews: hasNews,
      category: marketMeta.category,
      baseVolume: Math.max(1, window.reduce((a, b) => a + b, 0) / window.length),
    };

    const suspicion = computeSuspicion(syntheticMarket, bin.ts);

    return { ...bin, suspicion, zScore: Math.round(z * 10) / 10 };
  });
}

/**
 * Find spike onset — the first point where suspicion crosses the threshold.
 * Looks backward from the peak to find when the spike started building.
 */
export function findSpikeOnset(scoredBins, threshold = 60) {
  const spikes = [];
  let inSpike = false;
  let spikeStart = null;
  let spikePeak = null;

  for (let i = 0; i < scoredBins.length; i++) {
    const b = scoredBins[i];
    if (b.suspicion >= threshold && !inSpike) {
      inSpike = true;
      spikeStart = i;
      spikePeak = i;
    } else if (b.suspicion >= threshold && inSpike) {
      if (b.suspicion > scoredBins[spikePeak].suspicion) spikePeak = i;
    } else if (b.suspicion < threshold && inSpike) {
      spikes.push({
        startTs: scoredBins[spikeStart].ts,
        peakTs: scoredBins[spikePeak].ts,
        endTs: scoredBins[i].ts,
        peakSuspicion: scoredBins[spikePeak].suspicion,
        peakZ: scoredBins[spikePeak].zScore,
        peakVolume: scoredBins[spikePeak].volume,
        durationMins: Math.round((scoredBins[i].ts - scoredBins[spikeStart].ts) / 60000),
      });
      inSpike = false;
    }
  }

  // Handle spike that extends to end of data
  if (inSpike && spikeStart !== null) {
    const last = scoredBins.length - 1;
    spikes.push({
      startTs: scoredBins[spikeStart].ts,
      peakTs: scoredBins[spikePeak].ts,
      endTs: scoredBins[last].ts,
      peakSuspicion: scoredBins[spikePeak].suspicion,
      peakZ: scoredBins[spikePeak].zScore,
      peakVolume: scoredBins[spikePeak].volume,
      durationMins: Math.round((scoredBins[last].ts - scoredBins[spikeStart].ts) / 60000),
    });
  }

  return spikes;
}
