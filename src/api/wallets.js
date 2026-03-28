// ─── Wallet Intelligence Layer ──────────────────────────────
// Fetches per-trade wallet data from Polymarket Data API and
// checks wallet freshness via Polygon RPC. Produces a wallet
// risk assessment for each market.

// Call these APIs directly — both have CORS: Access-Control-Allow-Origin: *
const POLYDATA_BASE = "https://data-api.polymarket.com";
const POLYGON_RPC = "https://polygon.drpc.org";
const FETCH_TIMEOUT = 10000;

// ─── Caches ─────────────────────────────────────────────────
// Wallet tx counts rarely change — cache for 1 hour
const WALLET_CACHE_KEY = "dd_wallet_freshness";
const WALLET_CACHE_TTL = 3600000; // 1 hour
let _walletCache = null;

function loadWalletCache() {
  if (_walletCache) return _walletCache;
  try {
    const raw = localStorage.getItem(WALLET_CACHE_KEY);
    _walletCache = raw ? JSON.parse(raw) : {};
  } catch { _walletCache = {}; }
  return _walletCache;
}

function saveWalletCache() {
  try { localStorage.setItem(WALLET_CACHE_KEY, JSON.stringify(_walletCache || {})); } catch {}
}

// Trade data cache — per conditionId, refreshed every 30s
const _tradeCache = new Map(); // conditionId → { ts, trades, analysis }
const TRADE_CACHE_TTL = 30000; // 30 seconds

// RPC health — disable if first batch fails (avoid spamming broken endpoint)
let _rpcHealthy = true;
let _rpcLastCheck = 0;
const RPC_RETRY_INTERVAL = 300000; // Retry RPC after 5 min if it was down

// ─── Polymarket Data API ────────────────────────────────────

/**
 * Fetch recent trades for a Polymarket market by conditionId.
 * Returns trades with wallet addresses, sizes, prices, sides.
 */
export async function fetchRecentTrades(conditionId, limit = 100) {
  if (!conditionId) return [];
  try {
    const res = await fetch(`${POLYDATA_BASE}/trades?conditionId=${conditionId}&limit=${limit}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const trades = Array.isArray(data) ? data : [];
    return trades.map((t) => ({
      wallet: (t.proxyWallet || "").toLowerCase(),
      size: parseFloat(t.size) || 0,
      price: parseFloat(t.price) || 0,
      side: (t.side || "").toUpperCase(),
      outcome: t.outcome || null,
      timestamp: t.timestamp ? (typeof t.timestamp === "number" ? t.timestamp * 1000 : new Date(t.timestamp).getTime()) : Date.now(),
      name: t.pseudonym || t.name || null,
      txHash: t.transactionHash || null,
    }));
  } catch (e) {
    console.error("[Wallets] fetchRecentTrades failed:", e);
    return [];
  }
}

// ─── Polygon RPC — Wallet Freshness ─────────────────────────

/**
 * Check if a wallet is "fresh" (few lifetime transactions).
 * Uses Polygon RPC eth_getTransactionCount. Results cached for 1 hour.
 * Returns { address, txCount, isFresh }
 */
export async function checkWalletFreshness(address) {
  const cache = loadWalletCache();
  const cached = cache[address];
  if (cached && Date.now() - cached.ts < WALLET_CACHE_TTL) {
    return { address, txCount: cached.txCount, isFresh: cached.txCount < 5 };
  }

  // Skip RPC if endpoint is down (retry every 5 min)
  if (!_rpcHealthy && Date.now() - _rpcLastCheck < RPC_RETRY_INTERVAL) {
    return { address, txCount: -1, isFresh: false };
  }

  try {
    const res = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [address, "latest"], id: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const txCount = parseInt(data.result || "0x0", 16);
    cache[address] = { txCount, ts: Date.now() };
    _walletCache = cache;
    _rpcHealthy = true;
    saveWalletCache();
    return { address, txCount, isFresh: txCount < 5 };
  } catch (e) {
    // On failure, mark RPC as unhealthy and cache failure to avoid spam
    _rpcHealthy = false;
    _rpcLastCheck = Date.now();
    cache[address] = { txCount: -1, ts: Date.now() };
    _walletCache = cache;
    return { address, txCount: -1, isFresh: false };
  }
}

/**
 * Batch check freshness for multiple wallets.
 * Limits concurrent RPC calls to avoid rate limiting.
 */
async function batchCheckFreshness(addresses, maxConcurrent = 3) {
  const results = new Map();
  for (let i = 0; i < addresses.length; i += maxConcurrent) {
    const batch = addresses.slice(i, i + maxConcurrent);
    const checks = await Promise.all(batch.map(checkWalletFreshness));
    for (const c of checks) results.set(c.address, c);
  }
  return results;
}

// ─── Market Wallet Analysis ─────────────────────────────────

/**
 * Analyze wallet activity for a market's recent trades.
 * Returns a risk assessment object.
 */
export async function analyzeMarketWallets(conditionId) {
  if (!conditionId) return null;

  // Check trade cache
  const cached = _tradeCache.get(conditionId);
  if (cached && Date.now() - cached.ts < TRADE_CACHE_TTL) return cached.analysis;

  const trades = await fetchRecentTrades(conditionId, 100);
  if (trades.length === 0) {
    const empty = { freshWalletCount: 0, freshWalletVolume: 0, topWalletShare: 0, whaleCount: 0, totalVolume: 0, uniqueWallets: 0, walletRiskScore: 0, freshWallets: [], whales: [] };
    _tradeCache.set(conditionId, { ts: Date.now(), analysis: empty });
    return empty;
  }

  // Aggregate by wallet
  const walletVolumes = new Map(); // wallet → total $ volume
  const walletTrades = new Map(); // wallet → trade count
  let totalVolume = 0;
  let whaleCount = 0;
  const whales = [];

  for (const t of trades) {
    if (!t.wallet) continue;
    const dollarSize = t.size * t.price;
    walletVolumes.set(t.wallet, (walletVolumes.get(t.wallet) || 0) + dollarSize);
    walletTrades.set(t.wallet, (walletTrades.get(t.wallet) || 0) + 1);
    totalVolume += dollarSize;
    if (dollarSize >= 1000) {
      whaleCount++;
      whales.push({ wallet: t.wallet, size: dollarSize, name: t.name, side: t.side });
    }
  }

  // Find top wallet by volume
  let topWalletAddr = null;
  let topWalletVol = 0;
  for (const [addr, vol] of walletVolumes) {
    if (vol > topWalletVol) { topWalletVol = vol; topWalletAddr = addr; }
  }
  const topWalletShare = totalVolume > 0 ? topWalletVol / totalVolume : 0;

  // Check freshness for unique wallets (limit to top 15 by volume to stay within rate limits)
  const sortedWallets = [...walletVolumes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([addr]) => addr);
  const freshness = await batchCheckFreshness(sortedWallets);

  let freshWalletCount = 0;
  let freshWalletVolume = 0;
  const freshWallets = [];
  for (const [addr, vol] of walletVolumes) {
    const f = freshness.get(addr);
    if (f && f.isFresh) {
      freshWalletCount++;
      freshWalletVolume += vol;
      freshWallets.push({ wallet: addr, volume: vol, txCount: f.txCount, name: trades.find((t) => t.wallet === addr)?.name });
    }
  }

  // Compute wallet risk score (0.0 to 1.0)
  let riskScore = 0;
  const freshRatio = totalVolume > 0 ? freshWalletVolume / totalVolume : 0;
  if (freshRatio > 0.3) riskScore += 0.5;
  else if (freshRatio > 0.1) riskScore += 0.25;
  else if (freshWalletCount > 0) riskScore += 0.1;

  if (topWalletShare > 0.5) riskScore += 0.3;
  else if (topWalletShare > 0.3) riskScore += 0.15;

  if (whaleCount >= 3) riskScore += 0.2;
  else if (whaleCount >= 1) riskScore += 0.1;

  riskScore = Math.min(1.0, riskScore);

  const analysis = {
    freshWalletCount,
    freshWalletVolume: Math.round(freshWalletVolume),
    topWalletShare: Math.round(topWalletShare * 100) / 100,
    whaleCount,
    totalVolume: Math.round(totalVolume),
    uniqueWallets: walletVolumes.size,
    walletRiskScore: Math.round(riskScore * 100) / 100,
    freshWallets: freshWallets.slice(0, 5),
    whales: whales.slice(0, 5),
  };

  _tradeCache.set(conditionId, { ts: Date.now(), analysis });
  return analysis;
}

/**
 * Clear stale entries from trade cache.
 */
export function pruneWalletCache() {
  const now = Date.now();
  for (const [key, val] of _tradeCache) {
    if (now - val.ts > TRADE_CACHE_TTL * 10) _tradeCache.delete(key);
  }
}
