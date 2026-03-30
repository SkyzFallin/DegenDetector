// ─── Kalshi REST API ─────────────────────────────────────────
// Docs: https://docs.kalshi.com/
// Public market data, no auth required.
// Uses /events endpoint with nested markets for better quality results.

import { classifyCategory, LEAK_PROBS } from "./categories.js";

const BASE = "/api/kalshi";
const FETCH_TIMEOUT = 8000;

/**
 * Fetch active markets from Kalshi via the events endpoint.
 * All categories are included — filtering is done in the UI via toggle chips.
 */
export async function fetchKalshiMarkets(limit = 60) {
  try {
    const url = `${BASE}/events?limit=100&status=open&with_nested_markets=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`Kalshi ${res.status}`);
    const data = await res.json();
    const events = data.events || [];

    const results = [];
    const MAX_PER_EVENT = 3; // cap per event to avoid 15 Pope candidates drowning everything
    for (const event of events) {
      const markets = event.markets || [];
      // Sort by volume within event so we get the most active sub-markets
      const mapped = markets.map((m) => mapKalshi(m, event)).filter(Boolean);
      mapped.sort((a, b) => b.totalVolume24h - a.totalVolume24h);
      for (const m of mapped.slice(0, MAX_PER_EVENT)) {
        results.push(m);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    return results;
  } catch (err) {
    console.error("[Kalshi] fetch failed:", err);
    return [];
  }
}

function mapKalshi(m, event) {
  const price = parseFloat(m.last_price_dollars) || 0;
  const yesBid = parseFloat(m.yes_bid_dollars) || 0;
  const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
  const midPrice = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : price;
  const volume24h = parseFloat(m.volume_24h_fp) || 0;
  const totalVolume = parseFloat(m.volume_fp) || 0;

  // Skip combo/multi-leg markets, sports, and zero-activity markets
  if (m.strike_type === "custom" && m.mve_selected_legs?.length > 2) return null;
  if (m.title && m.title.length > 150) return null;
  if (totalVolume === 0 && volume24h === 0) return null;
  // Still filter out multi-game combo tickers (they have garbage titles)
  const ticker = (m.ticker || "").toUpperCase();
  if (/^KXMVE/.test(ticker)) return null;

  // Use event title if market title is just a ticker value
  const title = (m.title && m.title.length < 100) ? m.title : (event?.title || m.ticker || "Unknown");
  const categoryText = `${title} ${event?.category || ""} ${m.event_ticker || ""}`;
  const category = classifyCategory(categoryText);
  const expiryMs = m.expected_expiration_time
    ? new Date(m.expected_expiration_time).getTime() - Date.now()
    : 720 * 3600000;
  const prevPrice = parseFloat(m.previous_price_dollars) || midPrice;

  return {
    id: `kalshi-${m.ticker}`,
    sourceId: m.ticker,
    seriesTicker: event.series_ticker || null,
    venue: "Kalshi",
    name: title,
    category,
    leakProb: LEAK_PROBS[category] || 0.5,
    price: midPrice || price || 0.5,
    priceChange: midPrice - prevPrice,
    oi: Math.round(parseFloat(m.open_interest_fp) || 0),
    oiChange: 0,
    totalVolume24h: Math.round(volume24h),
    dollarVolume24h: Math.round(volume24h),
    lastTradeTs: m.updated_time ? new Date(m.updated_time).getTime() : Date.now(),
    expiryHours: Math.max(0, expiryMs / 3600000),
    pinned: false,
    hasRecentNews: Math.abs(midPrice - prevPrice) > 0.05,
    bestBid: yesBid || null,
    bestAsk: yesAsk || null,
    spread: (yesBid && yesAsk) ? yesAsk - yesBid : null,
    liquidity: parseFloat(m.liquidity_dollars) || 0,
    bins: new Array(90).fill(0),
    baseVolume: Math.max(1, Math.round((volume24h || 100) / 1440)),
  };
}
