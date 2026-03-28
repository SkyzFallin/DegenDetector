// ─── Combined Data Layer ─────────────────────────────────────
// Fetches from both Polymarket and Kalshi, merges, and manages
// the rolling volume bin accumulator.

import { fetchPolymarkets } from "./polymarket.js";
import { fetchKalshiMarkets } from "./kalshi.js";

// ─── Volume Bin Accumulator ──────────────────────────────────
// Tracks per-market volume in 1-minute bins over a 90-minute window.
// On each poll, the delta in 24h volume is attributed to the current bin.

const BIN_COUNT = 90;
const binStore = new Map(); // marketId → { bins: number[], lastVolume: number, lastBinTs: number }

function getCurrentBinIndex() {
  return Math.floor(Date.now() / 60000) % BIN_COUNT;
}

// Minimum number of polls before we trust a market's bin data for alerting.
// At 10s polling, 18 polls = ~3 minutes of baseline data.
const MIN_POLLS_FOR_ALERTING = 18;

function getOrCreateBinState(marketId, currentVolume, baseVolume) {
  if (!binStore.has(marketId)) {
    // Pre-fill bins with estimated per-minute volume so Z-scores are sane
    // from the start. Without this, 89 bins of 0 + 1 real bin = infinite Z.
    const estPerMin = Math.max(1, Math.round(baseVolume || currentVolume / 1440));
    binStore.set(marketId, {
      bins: new Array(BIN_COUNT).fill(estPerMin),
      lastVolume: currentVolume,
      lastBinTs: Date.now(),
      lastBinIdx: getCurrentBinIndex(),
      pollCount: 0,
    });
  }
  return binStore.get(marketId);
}

function updateBins(marketId, currentVolume, baseVolume) {
  const state = getOrCreateBinState(marketId, currentVolume, baseVolume);
  const nowIdx = getCurrentBinIndex();
  state.pollCount += 1;

  // If we've moved to a new bin, zero out skipped bins
  if (nowIdx !== state.lastBinIdx) {
    let idx = (state.lastBinIdx + 1) % BIN_COUNT;
    while (idx !== nowIdx) {
      state.bins[idx] = 0;
      idx = (idx + 1) % BIN_COUNT;
    }
    state.bins[nowIdx] = 0;
    state.lastBinIdx = nowIdx;
  }

  // Accumulate volume delta into current bin
  // Skip the very first poll — the initial delta is meaningless (not a real spike)
  if (state.pollCount > 1) {
    const delta = Math.max(0, currentVolume - state.lastVolume);
    state.bins[nowIdx] += delta;
  }
  state.lastVolume = currentVolume;

  // Return bins in chronological order (oldest first)
  const ordered = [];
  for (let i = 1; i <= BIN_COUNT; i++) {
    ordered.push(state.bins[(nowIdx + i) % BIN_COUNT]);
  }
  return ordered;
}

/**
 * Check if a market has enough bin history to be eligible for alerting.
 */
export function isAlertEligible(marketId) {
  const state = binStore.get(marketId);
  return state && state.pollCount >= MIN_POLLS_FOR_ALERTING;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Fetch all markets from both venues.
 * Merges into a single array with unified shape.
 */
export async function fetchAllMarkets() {
  const [poly, kalshi] = await Promise.all([
    fetchPolymarkets(60),
    fetchKalshiMarkets(60),
  ]);

  const all = [...poly, ...kalshi];

  // Update bins for each market
  for (const m of all) {
    m.bins = updateBins(m.id, m.totalVolume24h, m.baseVolume);
  }

  // Sort by 24h volume descending
  all.sort((a, b) => b.totalVolume24h - a.totalVolume24h);

  return all;
}

/**
 * Refresh prices/volumes for existing markets.
 * Returns updated market array with fresh bins.
 */
export async function refreshMarkets(existingMarkets) {
  const fresh = await fetchAllMarkets();

  // Merge: update existing markets with new data, preserve pins and UI state
  const existingMap = new Map(existingMarkets.map((m) => [m.id, m]));

  return fresh.map((m) => {
    const prev = existingMap.get(m.id);
    if (prev) {
      return {
        ...m,
        pinned: prev.pinned,
        // Calculate price change from our last known price (0 is a valid value)
        priceChange: m.price !== prev.price ? m.price - prev.price : m.priceChange,
      };
    }
    return m;
  });
}

/**
 * Clean up bin state for markets no longer tracked.
 */
export function pruneStale(activeIds) {
  const activeSet = new Set(activeIds);
  for (const id of binStore.keys()) {
    if (!activeSet.has(id)) binStore.delete(id);
  }
}
