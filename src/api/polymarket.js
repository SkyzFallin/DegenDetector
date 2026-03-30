// ─── Polymarket Gamma API ────────────────────────────────────
// Docs: https://docs.polymarket.com/developers/gamma-markets-api/overview
// All public, no auth required.

import { classifyCategory, LEAK_PROBS } from "./categories.js";

const BASE = "/api/poly";
const FETCH_TIMEOUT = 8000;
export const DEFAULT_LIMIT = 60;

/**
 * Fetch active markets from Polymarket.
 * Returns up to `limit` markets sorted by 24h volume (most active first).
 */
export async function fetchPolymarkets(limit = 60) {
  try {
    const url = `${BASE}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`Polymarket ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map(mapPolymarket).filter(Boolean);
  } catch (err) {
    console.error("[Polymarket] fetch failed:", err);
    return [];
  }
}

function mapPolymarket(m) {
  // Skip markets with no trading activity
  if (!m.outcomePrices || m.volumeNum === 0) return null;

  let prices;
  try { prices = JSON.parse(m.outcomePrices); }
  catch { return null; }
  const yesPrice = parseFloat(prices[0]) || 0.5;

  const category = classifyCategory(m.question + " " + (m.slug || ""), m.events);
  const expiryMs = m.endDate ? new Date(m.endDate).getTime() - Date.now() : 720 * 3600000;

  return {
    id: `poly-${m.id}`,
    sourceId: m.id,
    slug: m.slug || null,
    conditionId: m.conditionId || null,
    venue: "Polymarket",
    name: m.question || m.slug || "Unknown",
    category,
    leakProb: LEAK_PROBS[category] || 0.5,
    price: yesPrice,
    priceChange: m.oneDayPriceChange || 0,
    oi: 0,
    oiChange: 0,
    totalVolume24h: Math.round(m.volume24hr || 0),
    dollarVolume24h: Math.round(m.volume24hr || 0),
    lastTradeTs: m.updatedAt ? new Date(m.updatedAt).getTime() : Date.now(),
    expiryHours: Math.max(0, expiryMs / 3600000),
    pinned: false,
    hasRecentNews: Math.abs(m.oneDayPriceChange || 0) > 0.05,
    bestBid: m.bestBid || yesPrice - 0.005,
    bestAsk: m.bestAsk || yesPrice + 0.005,
    spread: m.spread || 0,
    oneHourPriceChange: m.oneHourPriceChange || 0,
    liquidity: m.liquidityNum || 0,
    bins: new Array(90).fill(0),
    baseVolume: Math.max(1, Math.round((m.volume24hr || 100) / 1440)),
  };
}
