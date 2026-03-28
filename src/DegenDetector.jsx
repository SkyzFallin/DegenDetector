import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from "recharts";
import { fetchAllMarkets, refreshMarkets, pruneStale, isAlertEligible } from "./api/index.js";

// ─── Theme ──────────────────────────────────────────────────────
const C = {
  bg: "#06080d",
  bgCard: "#0d1117",
  bgCardHover: "#151b26",
  bgElevated: "#1a2233",
  border: "#1b2436",
  borderActive: "#2d3f5e",
  text: "#e6edf5",
  textMuted: "#6b7d99",
  textDim: "#3d4f6a",
  neon: "#00ffaa",
  neonDim: "#00ffaa20",
  danger: "#ff3355",
  dangerDim: "#ff335518",
  warning: "#ffaa00",
  warningDim: "#ffaa0018",
  blue: "#3388ff",
  blueDim: "#3388ff18",
  poly: "#8855ff",
  kalshi: "#00bbff",
  sus100: "#ff0033",
  sus80: "#ff4400",
  sus60: "#ff8800",
  sus40: "#ccaa00",
  sus20: "#448866",
  sus0: "#335566",
};

// ─── Insider-relevant categories & markets ──────────────────────
const VENUES = ["Polymarket", "Kalshi"];
import { CATEGORIES } from "./api/categories.js";
import { median, mad, robustZ, clamp, computeSuspicion, susColor, susLabel, analyzeSpike } from "./scoring.js";
import HistoryView from "./HistoryView.jsx";

// Markets are now fetched live from Polymarket + Kalshi APIs

// ─── Utilities ──────────────────────────────────────────────────
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 11));

// Scoring functions (median, mad, robustZ, clamp, computeSuspicion, etc.)
// are imported from ./scoring.js — shared with the History tab

// createMarket removed — markets now come from live API data

function createAlert(market, z, vol, type = "volume_spike") {
  return {
    id: uid(), marketId: market.id, marketName: market.name,
    venue: market.venue, category: market.category, type,
    severity: z > 12 ? "critical" : z > 10 ? "high" : "medium",
    robustZ: Math.round(z * 10) / 10, volume: vol,
    price: market.price, priceChange: market.priceChange,
    suspicion: computeSuspicion(market), flags: analyzeSpike(market),
    timestamp: Date.now(), baselineMedian: Math.round(median(market.bins)),
    baselineMAD: Math.round(mad(market.bins) * 10) / 10, acked: false,
  };
}

// ─── Formatters ─────────────────────────────────────────────────
const ago = (ts) => { const d = (Date.now() - ts) / 1000; return d < 60 ? `${Math.round(d)}s` : d < 3600 ? `${Math.round(d / 60)}m` : `${Math.round(d / 3600)}h`; };
const fmtN = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`;
const fmtP = (p) => `${(p * 100).toFixed(1)}¢`;
const fmtExpiry = (h) => h < 1 ? `${Math.round(h * 60)}m` : h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;

// ─── Telegram ────────────────────────────────────────────────
const TG_STORAGE_KEY = "dd_telegram";

function loadTelegramConfig() {
  try { return JSON.parse(localStorage.getItem(TG_STORAGE_KEY) || "null"); } catch { return null; }
}

function saveTelegramConfig(cfg) {
  if (cfg) localStorage.setItem(TG_STORAGE_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(TG_STORAGE_KEY);
}

function formatTelegramMessage(alert) {
  const susLabel = alert.suspicion >= 80 ? "EXTREME" : alert.suspicion >= 60 ? "HIGH" : alert.suspicion >= 40 ? "ELEVATED" : "LOW";
  const priceStr = `${(alert.price * 100).toFixed(1)}¢`;
  const changeStr = `${alert.priceChange >= 0 ? "+" : ""}${(alert.priceChange * 100).toFixed(1)}¢`;
  const flagStr = alert.flags.map((f) => `${f.icon} ${f.text}`).join("\n");
  return [
    `🚨 *DEGEN DETECTED*`,
    ``,
    `*Market:* ${alert.marketName}`,
    `*Venue:* ${alert.venue}`,
    `*Suspicion:* ${alert.suspicion}/100 (${susLabel})`,
    `*Price:* ${priceStr} (${changeStr})`,
    `*Z-Score:* ${alert.robustZ}`,
    `*Severity:* ${alert.severity.toUpperCase()}`,
    ``,
    flagStr,
  ].join("\n");
}

async function sendTelegramMessage(botToken, chatId, text) {
  try {
    await fetch(`/api/telegram/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("[Telegram] send failed:", e);
  }
}

// ─── Sound ──────────────────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === "closed") {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}

function playAlertSound(severity) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); osc.type = "sine";
    const f = { critical: [880, 1100, 880], high: [660, 880], medium: [440, 550] };
    const notes = f[severity] || f.medium;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    notes.forEach((freq, i) => osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12));
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + notes.length * 0.12 + 0.1);
    osc.start(); osc.stop(ctx.currentTime + notes.length * 0.12 + 0.15);
  } catch (e) {}
}

// ─── Components ─────────────────────────────────────────────────
function DegenLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" style={{ animation: "logo-pulse 3s ease-in-out infinite" }}>
      <rect x="4" y="4" width="56" height="56" rx="14" fill={C.neon} opacity="0.1" stroke={C.neon} strokeWidth="1.5" />
      <path d="M20 22 L32 16 L44 22 L44 42 L32 48 L20 42 Z" fill="none" stroke={C.neon} strokeWidth="2" strokeLinejoin="round" />
      <path d="M32 16 L32 48 M20 22 L44 42 M44 22 L20 42" stroke={C.neon} strokeWidth="1" opacity="0.4" />
      <circle cx="32" cy="32" r="5" fill={C.neon} opacity="0.6">
        <animate attributeName="r" values="4;6;4" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function VenueBadge({ venue }) {
  const color = venue === "Polymarket" ? C.poly : C.kalshi;
  return (<span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 4, background: `${color}14`, color, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}66` }} />{venue}</span>);
}

function CatBadge({ cat }) {
  const icons = { Regulatory: "⚖️", Political: "🏛️", Financial: "💹", Legal: "⚖️", Geopolitical: "🌍", Corporate: "🏢", Sports: "🏈", Entertainment: "🎬", Science: "🔬", Climate: "🌡️" };
  return (<span style={{ fontSize: 9, color: C.textDim, padding: "2px 6px", background: C.border, borderRadius: 4 }}>{icons[cat] || "📌"} {cat}</span>);
}

function SuspicionBadge({ score, compact = false }) {
  const col = susColor(score);
  if (compact) return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 20, height: 20, borderRadius: "50%", background: `conic-gradient(${col} ${score * 3.6}deg, ${C.border} 0deg)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 13, height: 13, borderRadius: "50%", background: C.bgCard }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: col }}>{score}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: `${col}10`, border: `1px solid ${col}30` }}>
      <div style={{ width: 22, height: 22, borderRadius: "50%", background: `conic-gradient(${col} ${score * 3.6}deg, ${C.border} 0deg)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 14, height: 14, borderRadius: "50%", background: C.bgCard }} />
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: col, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: 8, fontWeight: 700, color: col, opacity: 0.7, letterSpacing: "0.08em" }}>{susLabel(score)}</div>
      </div>
    </div>
  );
}

function SpikeFlag({ flag }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: `${C.danger}08`, borderRadius: 6, border: `1px solid ${C.danger}15` }}>
      <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1.2 }}>{flag.icon}</span>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{flag.text}</div>
        <div style={{ fontSize: 10, color: C.textMuted }}>{flag.detail}</div>
      </div>
    </div>
  );
}

function ExpiryBadge({ hours }) {
  const urgent = hours < 1;
  const col = urgent ? C.danger : hours < 6 ? C.warning : C.textDim;
  return (<span style={{ fontSize: 9, fontWeight: 600, fontFamily: "'Azeret Mono', monospace", color: col, padding: "1px 5px", borderRadius: 4, background: urgent ? C.dangerDim : "transparent", animation: urgent ? "pulse 1s infinite" : "none" }}>{fmtExpiry(hours)}</span>);
}

let _sparkId = 0;
function Sparkline({ data, color = C.neon, h = 28, w = 90, hot = false }) {
  const gradId = useMemo(() => `sp-${++_sparkId}`, []);
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => ({ x: (i / (data.length - 1)) * w, y: h - (v / max) * (h - 4) - 2 }));
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const col = hot ? C.danger : color;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <defs><linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.25" /><stop offset="100%" stopColor={col} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${gradId})`} />
      <path d={d} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round" />
      {hot && pts.length > 0 && (<circle cx={pts.at(-1).x} cy={pts.at(-1).y} r="3" fill={col} stroke={C.bg} strokeWidth="1.5"><animate attributeName="r" values="3;5;3" dur="1.2s" repeatCount="indefinite" /></circle>)}
    </svg>
  );
}

function StatCard({ label, value, sub, color = C.text, icon }) {
  return (
    <div style={{ padding: "8px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, minWidth: 100, flex: "1 1 100px" }}>
      <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700, marginBottom: 3 }}>{icon && <span style={{ marginRight: 3 }}>{icon}</span>}{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "'Azeret Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: C.textDim, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function MarketRow({ market, isSelected, onClick, onPin, onFav, isFav }) {
  const warming = market._warmup;
  const bins = market.bins;
  const last5 = bins.slice(-5);
  const prev = bins.slice(0, -5);
  const recentAvg = last5.reduce((a, b) => a + b, 0) / (last5.length || 1);
  const baseAvg = Math.max(1, prev.reduce((a, b) => a + b, 0) / (prev.length || 1));
  const activity = warming ? 0 : recentAvg / baseAvg;
  const hot = !warming && activity > 4;
  const sus = warming ? 0 : computeSuspicion(market);
  return (
    <div onClick={onClick} style={{
      display: "grid", gridTemplateColumns: "minmax(0,1.5fr) 56px 62px 64px 90px 44px",
      alignItems: "center", gap: 5, padding: "8px 10px",
      background: isSelected ? C.bgCardHover : "transparent",
      borderBottom: `1px solid ${C.border}`, cursor: "pointer", transition: "background 0.15s",
      borderLeft: market.pinned ? `3px solid ${C.neon}44` : `3px solid transparent`,
    }} onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = C.bgCardHover; }}
       onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
          <button onClick={(e) => { e.stopPropagation(); onFav(market); }} title={isFav ? "Remove from favorites" : "Add to favorites"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: isFav ? C.warning : C.textDim, flexShrink: 0 }}>{isFav ? "★" : "☆"}</button>
          <button onClick={(e) => { e.stopPropagation(); onPin(market.id); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: market.pinned ? C.neon : C.textDim, flexShrink: 0 }}>{market.pinned ? "📌" : "·"}</button>
          {hot && <span style={{ fontSize: 8, animation: "pulse 0.8s infinite", flexShrink: 0 }}>🔥</span>}
          {!market.hasRecentNews && sus > 40 && <span style={{ fontSize: 8, flexShrink: 0 }} title="No correlated news">🔇</span>}
          <span style={{ fontSize: 11.5, fontWeight: 500, color: C.text, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{market.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 16 }}>
          <VenueBadge venue={market.venue} />
          <CatBadge cat={market.category} />
          <ExpiryBadge hours={market.expiryHours} />
        </div>
      </div>
      <SuspicionBadge score={sus} compact />
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Azeret Mono', monospace", color: C.text }}>{fmtP(market.price)}</div>
        <div style={{ fontSize: 9.5, fontFamily: "'Azeret Mono', monospace", fontWeight: 600, color: market.priceChange >= 0 ? C.neon : C.danger }}>{market.priceChange >= 0 ? "+" : ""}{(market.priceChange * 100).toFixed(1)}¢</div>
      </div>
      <div className="dd-col-vol" style={{ textAlign: "right" }}>
        <div style={{ fontSize: 10.5, fontFamily: "'Azeret Mono', monospace", color: C.textMuted }}>{fmtN(market.totalVolume24h)}</div>
        <div style={{ fontSize: 8.5, fontFamily: "'Azeret Mono', monospace", color: C.textDim }}>${fmtN(market.dollarVolume24h)}</div>
      </div>
      <div className="dd-col-spark" style={{ display: "flex", justifyContent: "flex-end" }}>
        <Sparkline data={market.bins.slice(-20)} hot={hot} />
      </div>
      <div style={{ textAlign: "right" }}>
        <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: warming ? C.textDim : activity > 5 ? C.danger : activity > 2 ? C.warning : C.textDim }}>{warming ? "—" : activity >= 10 ? `${Math.round(activity)}x` : activity >= 1.1 ? `${activity.toFixed(1)}x` : "—"}</span>
      </div>
    </div>
  );
}

function AlertCard({ alert, onAck }) {
  const [open, setOpen] = useState(false);
  return (
    <div onClick={() => setOpen(!open)} style={{
      padding: "12px 14px", background: C.bgCard,
      border: `1px solid ${alert.severity === "critical" ? C.danger + "33" : C.border}`,
      borderLeft: `3px solid ${susColor(alert.suspicion)}`,
      borderRadius: 8, cursor: "pointer", opacity: alert.acked ? 0.4 : 1, animation: "slide-in 0.3s ease-out",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
            <SuspicionBadge score={alert.suspicion} compact />
            <VenueBadge venue={alert.venue} />
            <CatBadge cat={alert.category} />
            <span style={{ fontSize: 10, color: C.textMuted }}>{ago(alert.timestamp)} ago</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 3 }}>{alert.marketName}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>
            {alert.type === "whale_print" ? "🐋 Whale" : "⚡ Spike"}{" — Z: "}<span style={{ color: C.neon, fontWeight: 700, fontFamily: "'Azeret Mono', monospace" }}>{alert.robustZ}</span>{" | "}<span style={{ fontFamily: "'Azeret Mono', monospace" }}>{fmtN(alert.volume)}</span> contracts
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: C.text }}>{fmtP(alert.price)}</div>
          <div style={{ fontSize: 11, fontWeight: 600, fontFamily: "'Azeret Mono', monospace", color: alert.priceChange >= 0 ? C.neon : C.danger }}>{alert.priceChange >= 0 ? "+" : ""}{(alert.priceChange * 100).toFixed(1)}¢</div>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          {alert.flags && alert.flags.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Why this looks suspicious</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{alert.flags.map((f, i) => <SpikeFlag key={i} flag={f} />)}</div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 11 }}>
            <div><div style={{ color: C.textMuted, marginBottom: 2 }}>Baseline Median</div><div style={{ color: C.text, fontFamily: "'Azeret Mono', monospace", fontWeight: 600 }}>{alert.baselineMedian} c/bin</div></div>
            <div><div style={{ color: C.textMuted, marginBottom: 2 }}>Baseline MAD</div><div style={{ color: C.text, fontFamily: "'Azeret Mono', monospace", fontWeight: 600 }}>{alert.baselineMAD}</div></div>
            <div><div style={{ color: C.textMuted, marginBottom: 2 }}>Leak Prob</div><div style={{ color: C.text, fontFamily: "'Azeret Mono', monospace", fontWeight: 600 }}>{Math.round((alert.flags?.find(f => f.icon === "🔓") ? 0.8 : 0.5) * 100)}%</div></div>
          </div>
          {!alert.acked && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={(e) => { e.stopPropagation(); onAck(alert.id); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 700, background: C.neonDim, color: C.neon, border: `1px solid ${C.neon}33`, borderRadius: 6, cursor: "pointer" }}>✓ ACK</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailPanel({ market, telegramCfg }) {
  if (!market) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: C.textDim, gap: 12, padding: 40, textAlign: "center" }}>
      <DegenLogo size={48} />
      <span style={{ fontSize: 13 }}>Select a market to inspect</span>
      <span style={{ fontSize: 10, maxWidth: 260, lineHeight: 1.5 }}>Markets ranked by Suspicion Score — a composite of spike suddenness, directional conviction, news absence, and leak probability.</span>
    </div>
  );

  const bins = market.bins;
  const med = median(bins);
  const threshold = med + 6 * (mad(bins) / 0.6745);
  const z = robustZ(bins.at(-1), bins);
  const sus = computeSuspicion(market);
  const flags = analyzeSpike(market);
  const chartData = bins.map((v, i) => ({ time: `${i - bins.length + 1}m`, volume: v }));
  const last20 = bins.slice(-20);
  const barData = last20.map((v, i) => ({ bin: `${i - 20 + 1}m`, vol: v, isSpike: v > threshold }));

  return (
    <div style={{ padding: 14, overflowY: "auto", height: "100%" }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          <VenueBadge venue={market.venue} />
          <CatBadge cat={market.category} />
          <ExpiryBadge hours={market.expiryHours} />
          {!market.hasRecentNews && (<span style={{ fontSize: 9, color: C.warning, padding: "2px 6px", background: C.warningDim, borderRadius: 4 }}>🔇 No recent news</span>)}
        </div>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: 0, marginBottom: 4 }}>{market.name}</h2>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: C.text }}>{fmtP(market.price)}</span>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Azeret Mono', monospace", color: market.priceChange >= 0 ? C.neon : C.danger }}>{market.priceChange >= 0 ? "▲" : "▼"} {Math.abs(market.priceChange * 100).toFixed(1)}¢</span>
        </div>
      </div>

      {/* Suspicion Score — centerpiece */}
      <div style={{ background: `${susColor(sus)}08`, border: `1px solid ${susColor(sus)}25`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Suspicion Score</div>
            {telegramCfg && <button onClick={() => { const alert = createAlert(market, z, market.bins.at(-1)); sendTelegramMessage(telegramCfg.botToken, telegramCfg.chatId, formatTelegramMessage(alert)); }} style={{ fontSize: 8, padding: "2px 6px", background: C.blue + "22", color: C.blue, border: `1px solid ${C.blue}33`, borderRadius: 3, cursor: "pointer", fontWeight: 700 }}>✈️ Send to Telegram</button>}
          </div>
          <SuspicionBadge score={sus} />
        </div>
        {/* Breakdown bars */}
        <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
          {[
            { label: "Suddenness", val: (() => { const r5 = bins.slice(-5); const p10 = bins.slice(-15,-5); const ra = r5.reduce((a,b)=>a+b,0)/(r5.length||1); const ba = Math.max(1,p10.reduce((a,b)=>a+b,0)/(p10.length||1)); return clamp((ra/ba-1)/4,0,20); })(), max: 20, col: C.danger },
            { label: "Z-Score", val: clamp(z / 12, 0, 1) * 15, max: 15, col: C.warning },
            { label: "Conviction", val: clamp(Math.abs(market.priceChange) / 0.10, 0, 1) * 15, max: 15, col: C.blue },
            { label: "Regime Shift", val: (() => { const cp = market.price, bp = market.baselinePrice; if (cp == null || bp == null) return 0; const r5 = bins.slice(-5); const p10 = bins.slice(-15,-5); const ra = r5.reduce((a,b)=>a+b,0)/(r5.length||1); const ba = Math.max(1,p10.reduce((a,b)=>a+b,0)/(p10.length||1)); if (ra <= ba * 2) return 0; return clamp(Math.abs(cp-bp)/0.50,0,1)*15*clamp(Math.max(cp,1-cp)/0.80,0,1); })(), max: 15, col: "#ff44ff" },
            { label: "Leak Prob", val: (market.leakProb || 0.5) * 15, max: 15, col: C.poly },
            { label: "Off-hrs", val: (() => { const hr = new Date().getUTCHours(); return (hr >= 22 || hr <= 6) ? 10 : (hr >= 20 || hr <= 8) ? 5 : 0; })(), max: 10, col: C.kalshi },
            { label: "No News", val: market.hasRecentNews ? 0 : 10, max: 10, col: C.neon },
          ].map((c) => (
            <div key={c.label} style={{ flex: c.max, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ height: 6, borderRadius: 3, background: C.border, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(c.val / c.max) * 100}%`, background: c.col, borderRadius: 3, transition: "width 0.5s" }} />
              </div>
              <span style={{ fontSize: 7, color: C.textDim, textAlign: "center" }}>{c.label}</span>
            </div>
          ))}
        </div>
        {flags.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{flags.map((f, i) => <SpikeFlag key={i} flag={f} />)}</div>
        ) : (
          <div style={{ fontSize: 11, color: C.textDim, textAlign: "center", padding: 8 }}>No suspicious indicators — appears organic</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        <StatCard label="Z-Score" value={z.toFixed(1)} color={z > 6 ? C.danger : C.neon} icon="📐" />
        <StatCard label="24h Vol" value={fmtN(market.totalVolume24h)} icon="📊" />
        <StatCard label="$ Vol" value={`$${fmtN(market.dollarVolume24h)}`} icon="💰" />
        <StatCard label="OI" value={fmtN(market.oi)} sub={`${market.oiChange >= 0 ? "+" : ""}${fmtN(market.oiChange)}`} icon="🎯" />
        <StatCard label="Leak Prob" value={`${Math.round(market.leakProb * 100)}%`} color={market.leakProb > 0.7 ? C.warning : C.textMuted} icon="🔓" />
      </div>

      {/* Volume chart */}
      {(() => { const dirColor = market.priceChange >= 0 ? C.neon : "#ff88cc"; const gradId = `vGrad-${market.id}`; return (
      <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Volume / Minute — 90m window</div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <defs><linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={dirColor} stopOpacity={0.2} /><stop offset="100%" stopColor={dirColor} stopOpacity={0} /></linearGradient></defs>
            <XAxis dataKey="time" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} interval={14} />
            <YAxis tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} width={28} />
            <Tooltip contentStyle={{ background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 10, color: C.text }} />
            <ReferenceLine y={Math.round(threshold)} stroke={C.danger} strokeDasharray="4 4" label={{ value: "Spike", fill: C.danger, fontSize: 8, position: "insideTopRight" }} />
            <ReferenceLine y={Math.round(med)} stroke={C.textDim} strokeDasharray="2 4" />
            <Area type="monotone" dataKey="volume" stroke={dirColor} fill={`url(#${gradId})`} strokeWidth={1.5} dot={false} animationDuration={400} />
          </AreaChart>
        </ResponsiveContainer>
      </div>); })()}

      {/* Bar chart — spike bins, colored by price direction */}
      <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Last 20 Bins — Spike Detection</div>
          <div style={{ display: "flex", gap: 8, fontSize: 8, color: C.textDim }}>
            <span><span style={{ display: "inline-block", width: 8, height: 3, background: C.neon, borderRadius: 1, marginRight: 3 }}/>YES pressure</span>
            <span><span style={{ display: "inline-block", width: 8, height: 3, background: "#ff88cc", borderRadius: 1, marginRight: 3 }}/>NO pressure</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={barData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <XAxis dataKey="bin" tick={{ fontSize: 7, fill: C.textDim }} axisLine={false} tickLine={false} interval={3} />
            <YAxis tick={{ fontSize: 7, fill: C.textDim }} axisLine={false} tickLine={false} width={24} />
            <ReferenceLine y={Math.round(threshold)} stroke={C.danger} strokeDasharray="3 3" />
            <Bar dataKey="vol" radius={[2, 2, 0, 0]}>{barData.map((d, i) => (<Cell key={i} fill={market.priceChange >= 0 ? C.neon : "#ff88cc"} opacity={d.isSpike ? 0.9 : 0.4} />))}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────
export default function DegenDetector() {
  const [markets, setMarkets] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState({ venue: "all", categories: new Set(), search: "", minSus: 0 });
  const [view, setView] = useState("dashboard");
  const [sortBy, setSortBy] = useState("suspicion");
  const [conn, setConn] = useState({ polymarket: "loading", kalshi: "loading" });
  const [soundOn, setSoundOn] = useState(true);
  const [telegramCfg, setTelegramCfg] = useState(() => loadTelegramConfig());
  const [showTgSettings, setShowTgSettings] = useState(false);
  const [tgDraft, setTgDraft] = useState({ botToken: "", chatId: "" });
  const [tgStatus, setTgStatus] = useState(null); // null | "ok" | "error" | "sending"
  const telegramRef = useRef(telegramCfg);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [monitoringSince] = useState(() => Date.now());
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dd_favorites") || "[]"); } catch { return []; }
  });
  const tickRef = useRef(0);
  const frozenRef = useRef(false);
  const marketsRef = useRef(markets);
  const soundOnRef = useRef(soundOn);
  useEffect(() => { marketsRef.current = markets; }, [markets]);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);
  useEffect(() => { telegramRef.current = telegramCfg; }, [telegramCfg]);

  // Keep rolling bin store bounded to currently tracked markets
  useEffect(() => {
    pruneStale(markets.map((m) => m.id));
  }, [markets]);

  // ─── Initial fetch ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAllMarkets();
        if (!cancelled) {
          setMarkets(data);
          setConn({ polymarket: "live", kalshi: "live" });
          setLastUpdated(Date.now());
          setFetchError(null);
          setLoading(false);
        }
      } catch (err) {
        console.error("[DegenDetector] initial fetch failed:", err);
        setConn({ polymarket: "error", kalshi: "error" });
        setFetchError("Failed to load markets. Check your connection and try again.");
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Polling loop: refresh every 10s ────────────────────────
  // Uses refs to avoid tearing down/recreating the interval on every state change
  useEffect(() => {
    if (loading) return;
    const iv = setInterval(async () => {
      if (frozenRef.current) return;
      tickRef.current += 1;
      try {
        const updated = await refreshMarkets(marketsRef.current);
        setMarkets(updated);

        // Check for alerts on updated data
        updated.forEach((m) => {
          // Skip alert checking until we have ~3min of baseline data
          if (!isAlertEligible(m.id)) return;

          const cur = m.bins.at(-1);
          const prevBins = m.bins.slice(0, -1);
          const prevMax = Math.max(...prevBins, 1);
          const ratio = cur / prevMax;
          const z = robustZ(cur, m.bins);

          // ALL gates must pass — rare, high-conviction event:
          // 1. Current bin ≥ 10x the previous maximum
          // 2. Z ≥ 8
          // 3. Suspicion ≥ 60
          // 4. ≥ 2 converging flags
          if (ratio >= 10 && z >= 8) {
            const sus = computeSuspicion(m);
            const flags = analyzeSpike(m);
            if (sus >= 60 && flags.length >= 2) {
              setAlerts((pa) => {
                if (pa.find((a) => a.marketId === m.id && Date.now() - a.timestamp < 900000)) return pa;
                const type = ratio >= 50 ? "whale_print" : "volume_spike";
                const alert = createAlert(m, z, cur, type);
                if (soundOnRef.current) playAlertSound(alert.severity);
                const tg = telegramRef.current;
                if (tg?.botToken && tg?.chatId) sendTelegramMessage(tg.botToken, tg.chatId, formatTelegramMessage(alert));
                return [alert, ...pa].slice(0, 50);
              });
            }
          }
        });

        setConn({ polymarket: "live", kalshi: "live" });
        setLastUpdated(Date.now());
        setFetchError(null);
      } catch (err) {
        console.error("[DegenDetector] refresh failed:", err);
        setFetchError("Data refresh failed — showing stale data. Retrying...");
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [loading]); // stable deps — reads from refs

  const ackAlert = useCallback((id) => setAlerts((p) => p.map((a) => a.id === id ? { ...a, acked: true } : a)), []);
  const togglePin = useCallback((id) => setMarkets((p) => p.map((m) => m.id === id ? { ...m, pinned: !m.pinned } : m)), []);
  const toggleFavorite = useCallback((market) => {
    setFavorites((prev) => {
      const exists = prev.find((f) => f.id === market.id);
      const next = exists ? prev.filter((f) => f.id !== market.id) : [...prev, {
        id: market.id, name: market.name, venue: market.venue, category: market.category,
        addedAt: Date.now(),
      }];
      try { localStorage.setItem("dd_favorites", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const isFavorite = useCallback((id) => favorites.some((f) => f.id === id), [favorites]);
  const manualRefresh = useCallback(async () => {
    try {
      const updated = await refreshMarkets(marketsRef.current);
      setMarkets(updated);
      setLastUpdated(Date.now());
      setFetchError(null);
      setConn({ polymarket: "live", kalshi: "live" });
    } catch (err) {
      setFetchError("Manual refresh failed.");
    }
  }, []);

  const filtered = useMemo(() => {
    return markets.filter((m) => {
      if (filter.venue !== "all" && m.venue !== filter.venue) return false;
      if (filter.categories.size > 0 && !filter.categories.has(m.category)) return false;
      if (filter.search && !m.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
      if (filter.minSus > 0 && (m._warmup || computeSuspicion(m) < filter.minSus)) return false;
      return true;
    }).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aFav = isFavorite(a.id), bFav = isFavorite(b.id);
      if (aFav !== bFav) return aFav ? -1 : 1;
      if (sortBy === "suspicion") return computeSuspicion(b) - computeSuspicion(a);
      if (sortBy === "z") return robustZ(b.bins.at(-1), b.bins) - robustZ(a.bins.at(-1), a.bins);
      if (sortBy === "volume") return b.totalVolume24h - a.totalVolume24h;
      if (sortBy === "leak") return (b.leakProb || 0) - (a.leakProb || 0);
      return 0;
    });
  }, [markets, filter, sortBy, isFavorite]);

  const selected = markets.find((m) => m.id === selectedId);
  const unacked = alerts.filter((a) => !a.acked).length;
  const highSus = alerts.filter((a) => a.suspicion >= 60).length;
  const readyMarkets = markets.filter((m) => !m._warmup);
  const avgSus = readyMarkets.length > 0 ? Math.round(readyMarkets.reduce((s, m) => s + computeSuspicion(m), 0) / readyMarkets.length) : 0;
  const ss = { background: C.bgCard, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 6px", fontSize: 10, cursor: "pointer", outline: "none" };

  return (
    <div onMouseEnter={() => { frozenRef.current = true; }} onMouseLeave={() => { frozenRef.current = false; }}
      style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", background: C.bg, color: C.text, minHeight: "100vh", display: "flex", flexDirection: "column", fontSize: 13 }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: ${C.bg}; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes logo-pulse { 0%,100% { filter: drop-shadow(0 0 4px ${C.neon}44); } 50% { filter: drop-shadow(0 0 12px ${C.neon}66); } }
        @keyframes slide-in { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes live-dot { 0%,100% { box-shadow: 0 0 4px ${C.neon}; } 50% { box-shadow: 0 0 10px ${C.neon}; opacity: 0.6; } }
        @keyframes scan { 0% { top: -2px; } 100% { top: 100%; } }
        button { font-family: inherit; } button:hover { filter: brightness(1.12); }
        @media (max-width: 768px) { .dd-hide-mobile { display: none !important; } .dd-main { flex-direction: column !important; } .dd-list { border-right: none !important; } .dd-col-spark, .dd-col-vol { display: none !important; } }
      `}</style>

      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none", zIndex: 9999, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${C.neon}06, transparent)`, animation: "scan 8s linear infinite" }} />
      </div>

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderBottom: `1px solid ${C.border}`, background: `${C.bgCard}ee`, backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100, gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <DegenLogo size={28} />
          <div>
            <h1 style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${C.neon}, ${C.blue})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>DegenDetector</h1>
            <span style={{ fontSize: 8, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase" }}>Insider Spike Detection</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {Object.entries(conn).map(([v, s]) => (
            <div key={v} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: s === "live" ? C.neon : C.warning, animation: s === "live" ? "live-dot 2s infinite" : "pulse 0.5s infinite" }} />
              <span style={{ fontSize: 9, color: C.textMuted, textTransform: "capitalize" }}>{v}</span>
            </div>
          ))}
          <button onClick={manualRefresh} title="Refresh now" style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.textMuted, borderRadius: 6, padding: "3px 7px", fontSize: 11, cursor: "pointer" }}>🔄</button>
          <button onClick={() => setSoundOn(!soundOn)} style={{ background: soundOn ? C.neonDim : "transparent", border: `1px solid ${soundOn ? C.neon + "33" : C.border}`, color: soundOn ? C.neon : C.textDim, borderRadius: 6, padding: "3px 7px", fontSize: 11, cursor: "pointer" }}>{soundOn ? "🔔" : "🔕"}</button>
          <button onClick={() => { setShowTgSettings(!showTgSettings); if (!showTgSettings && telegramCfg) setTgDraft({ botToken: telegramCfg.botToken, chatId: telegramCfg.chatId }); }} style={{ background: telegramCfg ? `${C.blue}22` : "transparent", border: `1px solid ${telegramCfg ? C.blue + "33" : C.border}`, color: telegramCfg ? C.blue : C.textDim, borderRadius: 6, padding: "3px 7px", fontSize: 11, cursor: "pointer" }} title="Telegram alerts">{telegramCfg ? "✈️" : "⚙️"}</button>
          <div style={{ display: "flex", background: C.border, borderRadius: 6, padding: 2 }}>
            {["dashboard", "alerts", "favorites", "history"].map((v) => (
              <button key={v} onClick={() => setView(v)} style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, background: view === v ? C.bgCard : "transparent", color: view === v ? C.text : C.textMuted, border: "none", borderRadius: 4, cursor: "pointer", position: "relative", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {v === "favorites" ? `★ ${favorites.length}` : v}{v === "alerts" && unacked > 0 && (<span style={{ position: "absolute", top: -3, right: -3, background: C.danger, color: "#fff", fontSize: 7, fontWeight: 800, padding: "1px 4px", borderRadius: 8, minWidth: 12, textAlign: "center", animation: "pulse 1s infinite" }}>{unacked}</span>)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Telegram settings panel */}
      {showTgSettings && (
        <div style={{ padding: "10px 14px", background: C.bgCard, borderBottom: `1px solid ${C.border}`, animation: "slide-in 0.15s ease-out" }}>
          <div style={{ maxWidth: 480, margin: "0 auto" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Telegram Alerts</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input type="password" placeholder="Bot Token (from @BotFather)" value={tgDraft.botToken} onChange={(e) => setTgDraft({ ...tgDraft, botToken: e.target.value })}
                style={{ flex: 2, padding: "5px 8px", fontSize: 10, background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, outline: "none", fontFamily: "'Azeret Mono', monospace" }} />
              <input type="text" placeholder="Chat ID (from @userinfobot)" value={tgDraft.chatId} onChange={(e) => setTgDraft({ ...tgDraft, chatId: e.target.value })}
                style={{ flex: 1, padding: "5px 8px", fontSize: 10, background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, outline: "none", fontFamily: "'Azeret Mono', monospace" }} />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => { const cfg = { botToken: tgDraft.botToken.trim(), chatId: tgDraft.chatId.trim() }; if (!cfg.botToken || !cfg.chatId) return; saveTelegramConfig(cfg); setTelegramCfg(cfg); setTgStatus("ok"); setTimeout(() => setTgStatus(null), 2000); }}
                style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, background: C.neon + "22", color: C.neon, border: `1px solid ${C.neon}33`, borderRadius: 4, cursor: "pointer" }}>Save</button>
              <button onClick={async () => { const t = tgDraft.botToken.trim(); const c = tgDraft.chatId.trim(); if (!t || !c) return; setTgStatus("sending"); try { const res = await fetch(`/api/telegram/bot${t}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: c, text: "✅ DegenDetector connected! You'll receive alerts here when insider activity is detected.", disable_web_page_preview: true }) }); setTgStatus(res.ok ? "ok" : "error"); } catch { setTgStatus("error"); } setTimeout(() => setTgStatus(null), 3000); }}
                style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, background: C.blue + "22", color: C.blue, border: `1px solid ${C.blue}33`, borderRadius: 4, cursor: "pointer" }}>{tgStatus === "sending" ? "..." : "Test"}</button>
              {telegramCfg && <button onClick={() => { saveTelegramConfig(null); setTelegramCfg(null); setTgDraft({ botToken: "", chatId: "" }); setTgStatus(null); }}
                style={{ padding: "4px 12px", fontSize: 10, fontWeight: 700, background: C.danger + "22", color: C.danger, border: `1px solid ${C.danger}33`, borderRadius: 4, cursor: "pointer" }}>Clear</button>}
              {tgStatus === "ok" && <span style={{ fontSize: 9, color: C.neon, fontWeight: 600 }}>Connected</span>}
              {tgStatus === "error" && <span style={{ fontSize: 9, color: C.danger, fontWeight: 600 }}>Failed — check token & chat ID</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 8, color: C.textDim }}>Get a bot token from @BotFather · Get your chat ID from @userinfobot</span>
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {fetchError && (
        <div style={{ padding: "6px 14px", background: C.dangerDim, borderBottom: `1px solid ${C.danger}33`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: C.danger, fontWeight: 600 }}>⚠️ {fetchError}</span>
          <button onClick={manualRefresh} style={{ fontSize: 10, padding: "2px 8px", background: C.danger + "22", color: C.danger, border: `1px solid ${C.danger}33`, borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>Retry</button>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: "flex", gap: 6, padding: "8px 14px", borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
        <StatCard label="Markets" value={markets.length} icon="🎯" />
        <StatCard label="Avg Suspicion" value={avgSus} color={susColor(avgSus)} icon="🔍" />
        <StatCard label="High-Sus Alerts" value={highSus} color={highSus > 0 ? C.danger : C.neon} icon="🚨" />
        <StatCard label="Unacked" value={unacked} color={unacked > 3 ? C.warning : C.text} icon="⚠️" />
      </div>

      {view === "history" ? (
        <HistoryView />
      ) : view === "dashboard" ? (
        <div className="dd-main" style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="dd-list" style={{ flex: "1 1 56%", display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 5, padding: "7px 10px", borderBottom: `1px solid ${C.border}`, alignItems: "center", flexWrap: "wrap" }}>
              <input type="text" placeholder="Search..." value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} style={{ ...ss, width: 120, fontFamily: "inherit" }} />
              <select value={filter.venue} onChange={(e) => setFilter({ ...filter, venue: e.target.value })} style={ss}><option value="all">All Venues</option>{VENUES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
              {CATEGORIES.map((c) => { const active = filter.categories.has(c); return (
                <button key={c} onClick={() => { const next = new Set(filter.categories); if (active) next.delete(c); else next.add(c); setFilter({ ...filter, categories: next }); }}
                  style={{ padding: "3px 7px", fontSize: 9, fontWeight: 700, background: active ? C.neonDim : "transparent", color: active ? C.neon : C.textDim, border: `1px solid ${active ? C.neon + "33" : C.border}`, borderRadius: 4, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.03em" }}>{c}</button>
              ); })}
              <select value={filter.minSus} onChange={(e) => setFilter({ ...filter, minSus: Number(e.target.value) })} style={ss}><option value={0}>All Levels</option><option value={20}>Sus ≥ 20</option><option value={40}>Sus ≥ 40</option><option value={60}>Sus ≥ 60</option><option value={80}>Sus ≥ 80</option></select>
              <div style={{ marginLeft: "auto", display: "flex", gap: 3, alignItems: "center" }}>
                <span style={{ fontSize: 8, color: C.textDim }}>Sort:</span>
                {["suspicion", "z", "volume", "leak"].map((s) => (
                  <button key={s} onClick={() => setSortBy(s)} style={{ padding: "2px 6px", fontSize: 8, fontWeight: 700, background: sortBy === s ? C.neonDim : "transparent", color: sortBy === s ? C.neon : C.textDim, border: `1px solid ${sortBy === s ? C.neon + "22" : "transparent"}`, borderRadius: 3, cursor: "pointer", textTransform: "uppercase" }}>{s === "suspicion" ? "sus" : s}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) 56px 62px 64px 90px 44px", gap: 5, padding: "5px 10px", fontSize: 8, fontWeight: 800, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${C.border}`, background: `${C.bgCard}88` }}>
              <span>Market</span><span>Sus</span><span style={{ textAlign: "right" }}>Yes ¢</span><span className="dd-col-vol" style={{ textAlign: "right" }}>Vol</span><span className="dd-col-spark" style={{ textAlign: "right" }}>Trend</span><span style={{ textAlign: "right" }}>Activity</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.map((m) => (<MarketRow key={m.id} market={m} isSelected={m.id === selectedId} onClick={() => setSelectedId(m.id)} onPin={togglePin} onFav={toggleFavorite} isFav={isFavorite(m.id)} />))}
              {loading && (<div style={{ padding: 40, textAlign: "center", color: C.neon, animation: "pulse 1.5s infinite" }}>⏳ Loading live markets from Polymarket & Kalshi...</div>)}
              {!loading && filtered.length === 0 && (<div style={{ padding: 40, textAlign: "center", color: C.textDim }}>No markets match filters</div>)}
            </div>
          </div>
          <div className="dd-hide-mobile" style={{ flex: "1 1 44%", minWidth: 0, overflow: "hidden" }}><DetailPanel market={selected} telegramCfg={telegramCfg} /></div>
        </div>
      ) : view === "favorites" ? (
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ fontSize: 13, fontWeight: 800, color: C.text, textTransform: "uppercase", letterSpacing: "0.04em" }}>★ Watchlist</h2>
              <span style={{ fontSize: 10, color: C.textMuted }}>{favorites.length} favorited · persists across sessions</span>
            </div>
            {favorites.length === 0 ? (
              <div style={{ padding: 50, textAlign: "center", color: C.textDim, background: C.bgCard, borderRadius: 12, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>★</div>
                <p style={{ fontSize: 12 }}>No favorites yet. Click the ☆ star on any market in the Dashboard to add it here.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {favorites.map((fav) => {
                  const liveMarket = markets.find((m) => m.id === fav.id);
                  return (
                    <div key={fav.id} style={{ padding: "10px 14px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
                      <button onClick={() => toggleFavorite(fav)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: C.warning }}>★</button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: fav.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: fav.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700, textTransform: "uppercase" }}>{fav.venue}</span>
                          <span style={{ fontSize: 9, padding: "2px 6px", background: C.border, borderRadius: 4, color: C.textDim }}>{fav.category}</span>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fav.name}</div>
                      </div>
                      {liveMarket ? (
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: C.text }}>{(liveMarket.price * 100).toFixed(1)}¢</div>
                          <div style={{ fontSize: 10, fontFamily: "'Azeret Mono', monospace", color: liveMarket.priceChange >= 0 ? C.neon : C.danger }}>{liveMarket.priceChange >= 0 ? "+" : ""}{(liveMarket.priceChange * 100).toFixed(1)}¢</div>
                          {!liveMarket._warmup && <div style={{ fontSize: 9, color: susColor(computeSuspicion(liveMarket)), fontWeight: 700 }}>Sus: {computeSuspicion(liveMarket)}</div>}
                        </div>
                      ) : (
                        <span style={{ fontSize: 9, color: C.textDim }}>Not live</span>
                      )}
                      <button onClick={() => { setSelectedId(fav.id); setView("dashboard"); }} style={{ padding: "4px 8px", fontSize: 9, fontWeight: 700, background: C.neonDim, color: C.neon, border: `1px solid ${C.neon}33`, borderRadius: 4, cursor: "pointer" }}>View</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ fontSize: 13, fontWeight: 800, color: C.text, textTransform: "uppercase", letterSpacing: "0.04em" }}>🚨 High-Conviction Signals</h2>
              <span style={{ fontSize: 10, color: C.textMuted }}>{highSus} signals · Z≥8 + Sus≥60 + 2+ flags</span>
            </div>
            {alerts.length === 0 ? (
              <div style={{ padding: 50, textAlign: "center", color: C.textDim, background: C.bgCard, borderRadius: 12, border: `1px solid ${C.border}` }}>
                <DegenLogo size={48} /><p style={{ marginTop: 12, fontSize: 12 }}>No high-conviction signals yet. Waiting for Z≥8 + Suspicion≥60 + multi-flag convergence...</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...alerts].sort((a, b) => b.suspicion - a.suspicion).map((a) => (<AlertCard key={a.id} alert={a} onAck={ackAlert} />))}
              </div>
            )}
          </div>
        </div>
      )}

      <footer style={{ padding: "5px 14px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 8, color: C.textDim, background: `${C.bgCard}aa`, gap: 10, flexWrap: "wrap" }}>
        <span>DegenDetector v2.0 · Z≥8 + Sus≥60 + 2+ flags · Robust Z (MAD) · 90 bin window · Off-hours = UTC</span>
        <span>Monitoring since {new Date(monitoringSince).toLocaleTimeString()}{lastUpdated ? ` · Updated ${ago(lastUpdated)} ago` : ""}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 4, height: 4, borderRadius: "50%", background: fetchError ? C.warning : C.neon, animation: fetchError ? "pulse 1s infinite" : "live-dot 2s infinite" }} />{fetchError ? "Degraded" : "Live"}</span>
      </footer>
    </div>
  );
}
