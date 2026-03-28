// ─── Scoring Utilities ──────────────────────────────────────
// Shared between live dashboard and historical spike scanner.
// All functions are pure — no side effects, no DOM, no state.

// Suspicion score color thresholds (match theme)
const SUS_COLORS = {
  sus100: "#ff0033",
  sus80: "#ff4400",
  sus60: "#ff8800",
  sus40: "#ccaa00",
  sus20: "#448866",
  sus0: "#335566",
};

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function median(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mad(a) {
  if (a.length === 0) return 0;
  const med = median(a);
  return median(a.map((v) => Math.abs(v - med)));
}

export function robustZ(val, win) {
  const m = median(win);
  const d = mad(win) + 0.001;
  return (0.6745 * (val - m)) / d;
}

// ─── SUSPICION SCORE ────────────────────────────────────────────
// The core idea: not all spikes are equal.
// A spike at 3am on a regulatory market with one-directional buying
// and no news is WAY more suspicious than a gradual ramp on a known event.

/**
 * @param {object} market - must have: bins, priceChange, leakProb, hasRecentNews
 * @param {number|null} atTime - optional timestamp (ms) for historical analysis;
 *   if null, uses current UTC time for off-hours detection
 */
export function computeSuspicion(market, atTime = null) {
  const bins = market.bins;
  const z = robustZ(bins.at(-1), bins);
  const last5 = bins.slice(-5);
  const prev10 = bins.slice(-15, -5);

  // 1. Spike suddenness (0-25)
  const recentAvg = last5.reduce((a, b) => a + b, 0) / (last5.length || 1);
  const baseAvg = Math.max(1, prev10.reduce((a, b) => a + b, 0) / (prev10.length || 1));
  const suddenness = clamp((recentAvg / baseAvg - 1) / 4, 0, 25);

  // 2. Z-score magnitude (0-20)
  const zScore = clamp(z / 12, 0, 1) * 20;

  // 3. Directional conviction (0-20)
  const conviction = clamp(Math.abs(market.priceChange) / 0.10, 0, 1) * 20;

  // 4. Leak probability of market type (0-15)
  const leakComponent = (market.leakProb || 0.5) * 15;

  // 5. Off-hours bonus (0-10) — uses atTime for historical, current time for live
  const hour = atTime ? new Date(atTime).getUTCHours() : new Date().getUTCHours();
  const offHours = (hour >= 22 || hour <= 6) ? 10 : (hour >= 20 || hour <= 8) ? 5 : 0;

  // 6. No-news flag (0-10)
  const noNews = market.hasRecentNews ? 0 : 10;

  return Math.round(clamp(suddenness + zScore + conviction + leakComponent + offHours + noNews, 0, 100));
}

export function susColor(score) {
  if (score >= 80) return SUS_COLORS.sus100;
  if (score >= 60) return SUS_COLORS.sus80;
  if (score >= 40) return SUS_COLORS.sus60;
  if (score >= 20) return SUS_COLORS.sus40;
  return SUS_COLORS.sus0;
}

export function susLabel(score) {
  if (score >= 80) return "EXTREME";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "ELEVATED";
  if (score >= 20) return "LOW";
  return "BASELINE";
}

export function analyzeSpike(market) {
  const bins = market.bins;
  const last5 = bins.slice(-5);
  const prev20 = bins.slice(-25, -5);
  const recentAvg = last5.reduce((a, b) => a + b, 0) / (last5.length || 1);
  const baseAvg = Math.max(1, prev20.reduce((a, b) => a + b, 0) / (prev20.length || 1));
  const ratio = recentAvg / baseAvg;
  const flags = [];
  if (ratio > 10) flags.push({ icon: "⚡", text: `${Math.round(ratio)}x baseline volume`, detail: `Went from ~${Math.round(baseAvg)} to ${Math.round(recentAvg)} contracts/min` });
  if (Math.abs(market.priceChange) > 0.04) flags.push({ icon: market.priceChange > 0 ? "📈" : "📉", text: "Strong directional conviction", detail: `${market.priceChange > 0 ? "+" : ""}${(market.priceChange * 100).toFixed(1)}¢ — one-sided buying` });
  if (!market.hasRecentNews) flags.push({ icon: "🔇", text: "No correlated news detected (heuristic)", detail: "Volume precedes public information — inferred from price stability" });
  const hour = new Date().getUTCHours();
  if (hour >= 22 || hour <= 6) flags.push({ icon: "🌙", text: "Off-hours activity", detail: "Spike during low-traffic window" });
  if (market.leakProb > 0.7) flags.push({ icon: "🔓", text: "High leak-probability market", detail: `${market.category} decisions often leak pre-announcement` });
  if (bins.at(-1) > (market.baseVolume || 1) * 50) flags.push({ icon: "🐋", text: "Whale-sized print", detail: `${bins.at(-1)} contracts — ${Math.round(bins.at(-1) / (market.baseVolume || 1))}x normal` });
  return flags;
}
