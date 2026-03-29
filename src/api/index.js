// ─── Combined Data Layer ─────────────────────────────────────
// Fetches from both Polymarket and Kalshi, merges, and manages
// the rolling volume bin accumulator.

import { fetchPolymarkets } from "./polymarket.js";
import { fetchKalshiMarkets } from "./kalshi.js";
import { analyzeMarketWallets, pruneWalletCache } from "./wallets.js";

// ─── Volume Bin Accumulator ──────────────────────────────────
// Tracks per-market volume in 1-minute bins over a 90-minute window.
// On each poll, the delta in 24h volume is attributed to the current bin.

const BIN_COUNT = 90;
const binStore = new Map(); // marketId → { bins: number[], lastVolume: number, lastBinTs: number }
const BIN_CACHE_KEY = "dd_bin_cache";
const BIN_CACHE_MAX_AGE = 90 * 60000; // 90 minutes — older cache is useless
let _lastCacheSave = 0;

function getCurrentBinIndex() {
  return Math.floor(Date.now() / 60000) % BIN_COUNT;
}

// Minimum number of polls before we trust a market's bin data for alerting.
// At 10s polling, 18 polls = ~3 minutes of baseline data.
const MIN_POLLS_FOR_ALERTING = 18;

// ─── Bin Cache: persist to localStorage to skip warmup on restart ───

function saveBinCache() {
  // Throttle: save at most every 30 seconds
  if (Date.now() - _lastCacheSave < 30000) return;
  _lastCacheSave = Date.now();
  try {
    const data = {};
    for (const [id, state] of binStore) {
      data[id] = { bins: state.bins, lastVolume: state.lastVolume, lastBinIdx: state.lastBinIdx, pollCount: state.pollCount };
    }
    const json = JSON.stringify({ ts: Date.now(), data });
    localStorage.setItem(BIN_CACHE_KEY, json);
  } catch (e) { console.warn("[BinCache] localStorage save failed:", e.message); }
}

function restoreBinCache() {
  try {
    const raw = localStorage.getItem(BIN_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    if (!cache?.ts || !cache?.data) return;

    const age = Date.now() - cache.ts;
    if (age > BIN_CACHE_MAX_AGE) {
      localStorage.removeItem(BIN_CACHE_KEY);
      return;
    }

    const nowIdx = getCurrentBinIndex();
    for (const [id, saved] of Object.entries(cache.data)) {
      // Zero out bins that would have been skipped since last save
      const bins = [...saved.bins];
      if (saved.lastBinIdx !== nowIdx) {
        let idx = (saved.lastBinIdx + 1) % BIN_COUNT;
        while (idx !== nowIdx) {
          bins[idx] = 0;
          idx = (idx + 1) % BIN_COUNT;
        }
        bins[nowIdx] = 0;
      }
      binStore.set(id, {
        bins,
        lastVolume: saved.lastVolume,
        lastBinTs: Date.now(),
        lastBinIdx: nowIdx,
        // Warmup already satisfied; _skipNextDelta discards the first stale volume delta
        pollCount: Math.max(saved.pollCount, MIN_POLLS_FOR_ALERTING),
        _skipNextDelta: true,
      });
    }
  } catch {
    localStorage.removeItem(BIN_CACHE_KEY);
  }
}

// Restore on module load
restoreBinCache();

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
  const binsSkipped = (nowIdx - state.lastBinIdx + BIN_COUNT) % BIN_COUNT;
  if (binsSkipped > 0) {
    // If gap is huge (>= full window), we've been inactive too long — skip the delta
    const gapTooLarge = binsSkipped >= BIN_COUNT - 1;
    if (gapTooLarge) state._skipNextDelta = true;
    let idx = (state.lastBinIdx + 1) % BIN_COUNT;
    while (idx !== nowIdx) {
      state.bins[idx] = 0;
      idx = (idx + 1) % BIN_COUNT;
    }
    state.bins[nowIdx] = 0;
    state.lastBinIdx = nowIdx;
  }

  // Accumulate volume delta into current bin
  // Skip the very first poll, post-restore poll, or post-gap poll
  if (state.pollCount > 1 && !state._skipNextDelta) {
    const delta = Math.max(0, currentVolume - state.lastVolume);
    state.bins[nowIdx] += delta;
  }
  state._skipNextDelta = false;
  state.lastVolume = currentVolume;
  saveBinCache();

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

// ─── Venue Status Tracking ──────────────────────────────────
// Tracks which venues returned data on the last fetch so the UI
// can distinguish "all good" from "partial failure".
let _venueStatus = { polymarket: "ok", kalshi: "ok" };
export function getVenueStatus() { return _venueStatus; }

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
  _venueStatus = {
    polymarket: poly.length > 0 ? "ok" : "error",
    kalshi: kalshi.length > 0 ? "ok" : "error",
  };

  // Deduplicate by name — keep the highest-volume version of same-named markets
  const byName = new Map();
  for (const m of [...poly, ...kalshi]) {
    const existing = byName.get(m.name);
    if (!existing || m.totalVolume24h > existing.totalVolume24h) {
      byName.set(m.name, m);
    }
  }
  const all = [...byName.values()];

  // Update bins for each market + flag warmup status
  for (const m of all) {
    m.bins = updateBins(m.id, m.totalVolume24h, m.baseVolume);
    m._warmup = !isAlertEligible(m.id);
  }

  // Sort by 24h volume descending
  all.sort((a, b) => b.totalVolume24h - a.totalVolume24h);

  return all;
}

/**
 * Refresh prices/volumes for existing markets.
 * Returns updated market array with fresh bins.
 */
const CLOSED_KEEP_MS = 3600000; // Keep closed markets for 1 hour

export async function refreshMarkets(existingMarkets, favoriteIds = new Set()) {
  const fresh = await fetchAllMarkets();

  // Merge: update existing markets with new data, preserve pins and UI state
  const existingMap = new Map(existingMarkets.map((m) => [m.id, m]));
  const freshIds = new Set(fresh.map((m) => m.id));

  const merged = fresh.map((m) => {
    const prev = existingMap.get(m.id);
    if (prev) {
      return {
        ...m,
        pinned: prev.pinned,
        // Calculate price change from our last known price (0 is a valid value)
        priceChange: m.price !== prev.price ? m.price - prev.price : 0,
        // Track the first price we saw for this market — used for price flip detection
        baselinePrice: prev.baselinePrice ?? prev.price,
        // Track when market closed (negative expiry)
        _closedAt: m.expiryHours < 0.02 ? (prev._closedAt || Date.now()) : null,
      };
    }
    return { ...m, baselinePrice: m.price, _closedAt: m.expiryHours < 0.02 ? Date.now() : null };
  });

  // Keep recently-closed markets that the API no longer returns (up to 1 hour)
  for (const prev of existingMarkets) {
    if (!freshIds.has(prev.id)) {
      const closedAt = prev._closedAt || Date.now();
      const isFav = favoriteIds.has(prev.id);
      if (isFav || Date.now() - closedAt < CLOSED_KEEP_MS) {
        merged.push({ ...prev, _closedAt: closedAt, _stale: true });
      }
    }
  }

  // Wallet intelligence: analyze top Polymarket markets (throttled to every 30s)
  // Results stored in _walletResults cache so they persist across poll cycles
  const now = Date.now();
  if (now - _lastWalletScan > 30000) {
    _lastWalletScan = now;
    const polyMarkets = merged
      .filter((m) => m.venue === "Polymarket" && m.conditionId && !m._closedAt)
      .sort((a, b) => b.totalVolume24h - a.totalVolume24h)
      .slice(0, 20);
    // Fire-and-forget: results land in _walletResults for next poll cycle
    Promise.all(polyMarkets.map(async (m) => {
      try {
        const wr = await analyzeMarketWallets(m.conditionId);
        if (wr && wr.uniqueWallets > 0) _walletResults.set(m.conditionId, wr);
      } catch {}
    })).then(() => pruneWalletCache()).catch((e) => console.error("[Wallets] batch analysis failed:", e));
  }
  // Attach wallet data from cache (available from previous scan cycle)
  for (const m of merged) {
    if (m.conditionId && _walletResults.has(m.conditionId)) {
      m.walletRisk = _walletResults.get(m.conditionId);
    }
  }

  return merged;
}

let _lastWalletScan = 0;
const _walletResults = new Map(); // conditionId → walletRisk analysis

/**
 * Clean up bin state for markets no longer tracked.
 */
export function pruneStale(activeIds) {
  const activeSet = new Set(activeIds);
  for (const id of binStore.keys()) {
    if (!activeSet.has(id)) binStore.delete(id);
  }
}
