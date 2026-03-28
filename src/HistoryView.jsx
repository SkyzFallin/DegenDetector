import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, ComposedChart, Bar, Line, Cell } from "recharts";
import { searchMarkets, fetchKalshiTrades, fetchPolyPriceHistory, binKalshiTrades, binPolyPrices, computeRetroactiveScores, findSpikeOnset } from "./api/history.js";
import { susColor, susLabel } from "./scoring.js";

// ─── Theme (matches DegenDetector) ──────────────────────────
const C = {
  bg: "#06080d", bgCard: "#0d1117", bgCardHover: "#151b26", bgElevated: "#1a2233",
  border: "#1b2436", text: "#e6edf5", textMuted: "#6b7d99", textDim: "#3d4f6a",
  neon: "#00ffaa", neonDim: "#00ffaa20", danger: "#ff3355", dangerDim: "#ff335518",
  warning: "#ffaa00", blue: "#3388ff", poly: "#8855ff", kalshi: "#00bbff",
};

const fmtTs = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
const fmtDuration = (mins) => mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 11));

// Must match fmtBinTime in api/history.js for chart x-axis matching
function fmtBinTime(ts) {
  const d = new Date(ts);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

// Find the closest chart bin time string for a given timestamp
function findClosestBinTime(ts, chartData) {
  if (!chartData.length) return null;
  let closest = chartData[0];
  let minDiff = Infinity;
  for (const d of chartData) {
    const diff = Math.abs(d.ts - ts);
    if (diff < minDiff) { minDiff = diff; closest = d; }
  }
  return closest.time;
}

// ─── Preset Case Studies ────────────────────────────────────
// Real examples of suspected insider trading on prediction markets.
// These pre-fill the search, date range, and news annotation.
const PRESETS = [
  {
    label: "Iran Leader — Mojtaba Khamenei 🚨",
    description: "+13¢ price move with 217K contracts in the final 2 hours. Insiders knew the succession outcome.",
    search: "khamenei",
    venue: "Kalshi",
    dateStart: "2026-03-08T18:00",
    dateEnd: "2026-03-08T23:00",
    newsHeadline: "Mojtaba Khamenei confirmed as Supreme Leader",
    newsTime: "2026-03-08T21:44",
  },
  {
    label: "Next Pope — Robert Prevost 🚨",
    description: "THE smoking gun: price went 2¢ → 99¢ with 111K contracts in 2 hours. Someone knew the conclave result.",
    search: "prevost",
    venue: "Kalshi",
    dateStart: "2025-05-08T14:00",
    dateEnd: "2025-05-08T18:00",
    newsHeadline: "White smoke — Robert Prevost elected Pope",
    newsTime: "2025-05-08T17:26",
  },
  {
    label: "Fed Chair Nomination — Warsh",
    description: "3,252-contract whale print at 14:10 UTC. News broke ~15:00. One hour of insider advantage.",
    search: "fed chair",
    venue: "Kalshi",
    dateStart: "2026-03-05T08:00",
    dateEnd: "2026-03-05T20:00",
    newsHeadline: "Trump to nominate Kevin Warsh as Fed Chair",
    newsTime: "2026-03-05T15:00",
  },
  {
    label: "US Forces Enter Iran",
    description: "Polymarket Iran markets — check for volume activity before military action announcements",
    search: "iran",
    venue: "Polymarket",
    dateStart: "2026-03-25T00:00",
    dateEnd: "2026-03-28T00:00",
    newsHeadline: "US forces enter Iran",
    newsTime: "2026-03-26T12:00",
  },
];

export default function HistoryView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [dateRange, setDateRange] = useState(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    return { start: start.toISOString().slice(0, 16), end: end.toISOString().slice(0, 16) };
  });
  const [scoredData, setScoredData] = useState(null);
  const [spikes, setSpikes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annoText, setAnnoText] = useState("");
  const [annoTime, setAnnoTime] = useState("");
  const [zoomHours, setZoomHours] = useState(null); // null = show all data

  // ─── Search ───────────────────────────────────────────────
  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await searchMarkets(query.trim());
      setResults(res);
      if (res.length === 0) setError("No markets found for that keyword.");
    } catch (e) {
      setError("Search failed.");
    }
    setSearching(false);
  }, [query]);

  // ─── Fetch Historical Data ────────────────────────────────
  // Can be called with explicit params (for auto-fetch on select)
  // or defaults to current state (for manual Fetch button)
  const fetchData = useCallback(async (overrideMarket, overrideDateRange) => {
    const market = overrideMarket || selected;
    const dr = overrideDateRange || dateRange;
    if (!market) return;
    setLoading(true);
    setError(null);
    setScoredData(null);
    setSpikes([]);

    const startMs = new Date(dr.start).getTime();
    const endMs = new Date(dr.end).getTime();

    if (endMs <= startMs) {
      setError("End date must be after start date.");
      setLoading(false);
      return;
    }

    try {
      let bins;
      if (market.venue === "Kalshi") {
        const trades = await fetchKalshiTrades(market.ticker, startMs, endMs);
        if (trades.length === 0) {
          setError("No trades found in this date range. Try adjusting the date range.");
          setLoading(false);
          return;
        }
        bins = binKalshiTrades(trades, startMs, endMs);
      } else {
        const prices = await fetchPolyPriceHistory(market.tokenId, startMs, endMs);
        if (prices.length === 0) {
          setError("No price data found. Polymarket may have limited history for resolved markets.");
          setLoading(false);
          return;
        }
        bins = binPolyPrices(prices, startMs, endMs);
      }

      const scored = computeRetroactiveScores(bins, { category: market.category });
      const detected = findSpikeOnset(scored, 60);
      setScoredData(scored);
      setSpikes(detected);
    } catch (e) {
      console.error("[HistoryView] fetch error:", e);
      setError("Failed to load historical data.");
    }
    setLoading(false);
  }, [selected, dateRange]);

  // ─── Annotations ──────────────────────────────────────────
  const addAnnotation = useCallback(() => {
    if (!annoText.trim() || !annoTime) return;
    setAnnotations((prev) => [...prev, { id: uid(), text: annoText.trim(), ts: new Date(annoTime).getTime() }]);
    setAnnoText("");
    setAnnoTime("");
  }, [annoText, annoTime]);

  const removeAnnotation = useCallback((id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ─── Load a case study preset ──────────────────────────────
  const loadPreset = useCallback(async (preset) => {
    setQuery(preset.search);
    setDateRange({ start: preset.dateStart, end: preset.dateEnd });
    setAnnotations([{ id: uid(), text: preset.newsHeadline, ts: new Date(preset.newsTime).getTime() }]);
    setScoredData(null);
    setSpikes([]);
    setSelected(null);
    // Trigger search
    setSearching(true);
    setError(null);
    try {
      const res = await searchMarkets(preset.search);
      setResults(res);
      if (res.length === 0) setError("No markets found — try adjusting the search.");
    } catch (e) {
      setError("Search failed.");
    }
    setSearching(false);
  }, []);

  // ─── Quick date presets ───────────────────────────────────
  const setPreset = (hours) => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600000);
    setDateRange({ start: start.toISOString().slice(0, 16), end: end.toISOString().slice(0, 16) });
  };

  // ─── Evidence: match spikes to annotations ────────────────
  const evidence = useMemo(() => {
    if (!spikes.length || !annotations.length) return [];
    return spikes.map((spike) => {
      // Find nearest annotation AFTER the spike start
      const after = annotations.filter((a) => a.ts > spike.startTs).sort((a, b) => a.ts - b.ts);
      const nearest = after[0];
      if (!nearest) return null;
      const gapMins = Math.round((nearest.ts - spike.startTs) / 60000);
      if (gapMins <= 0) return null;
      return { spike, annotation: nearest, gapMins };
    }).filter(Boolean);
  }, [spikes, annotations]);

  // ─── Chart data (zoom + downsample) ────────────────────────
  const chartData = useMemo(() => {
    if (!scoredData || scoredData.length === 0) return [];
    let data = scoredData;

    // Apply zoom: show X hours BEFORE close, 10 min after
    if (zoomHours) {
      const closeAnno = annotations.find((a) => a.auto);
      const anchorTs = closeAnno ? closeAnno.ts : data[data.length - 1].ts;
      const windowMs = zoomHours * 3600000;
      data = data.filter((d) => d.ts >= anchorTs - windowMs && d.ts <= anchorTs + 600000);
      if (data.length === 0) data = scoredData; // fallback
    }

    // Downsample if still too many points
    if (data.length > 1440) {
      const step = Math.ceil(data.length / 1440);
      return data.filter((_, i) => i % step === 0);
    }
    return data;
  }, [scoredData, zoomHours, annotations]);

  const ss = { background: C.bgCard, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, outline: "none", fontFamily: "inherit" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        {/* Search */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
            🔍 Historical Spike Scanner
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              type="text" placeholder="Search markets (e.g. iran, oil, bitcoin, pope)..."
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              style={{ ...ss, flex: 1 }}
            />
            <button onClick={doSearch} disabled={searching}
              style={{ ...ss, background: C.neonDim, color: C.neon, border: `1px solid ${C.neon}33`, cursor: "pointer", fontWeight: 700 }}>
              {searching ? "..." : "Search"}
            </button>
          </div>

          {/* Results */}
          {results.length > 0 && !selected && (
            <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 480, overflowY: "auto" }}>
              {results.map((m) => (
                <div key={m.id} onClick={() => {
                    setSelected(m);
                    setResults([]);
                    // Auto-add close/settlement markers for settled Kalshi markets
                    const autoAnnotations = [];
                    if (m.closeTime) autoAnnotations.push({ id: uid(), text: `Result confirmed${m.result ? ` — ${m.result.toUpperCase()} wins` : ""} · Betting stopped`, ts: new Date(m.closeTime).getTime(), auto: true });
                    // Clear all annotations (including preset news) and only show the real close marker
                    setAnnotations(autoAnnotations);
                    // Auto-zoom: 4 hours before close → 15 min after (no wasted space)
                    let dr = dateRange;
                    if (m.closeTime) {
                      const closeMs = new Date(m.closeTime).getTime();
                      dr = { start: new Date(closeMs - 4 * 3600000).toISOString().slice(0, 16), end: new Date(closeMs + 15 * 60000).toISOString().slice(0, 16) };
                      setDateRange(dr);
                    }
                    // Auto-fetch immediately with the market and date range
                    fetchData(m, dr);
                  }}
                  style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}
                  onMouseEnter={(e) => e.currentTarget.style.background = C.bgCardHover}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: m.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: m.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700, textTransform: "uppercase" }}>{m.venue}</span>
                  <span style={{ fontSize: 11, color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                  {m.volume > 0 && <span style={{ fontSize: 9, color: C.textDim, fontFamily: "'Azeret Mono', monospace", flexShrink: 0 }}>{m.volume >= 1e6 ? `${(m.volume/1e6).toFixed(1)}M` : m.volume >= 1e3 ? `${(m.volume/1e3).toFixed(0)}K` : m.volume} vol</span>}
                  {m.result && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 700, flexShrink: 0, background: m.result === "yes" ? `${C.neon}20` : `${C.danger}20`, color: m.result === "yes" ? C.neon : C.danger }}>{m.result.toUpperCase()}</span>}
                  <span style={{ fontSize: 9, color: m.status === "active" ? C.neon : C.textDim, fontWeight: 600, flexShrink: 0 }}>{m.status}</span>
                </div>
              ))}
            </div>
          )}

          {/* Selected market */}
          {selected && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: selected.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: selected.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700, textTransform: "uppercase" }}>{selected.venue}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, flex: 1 }}>{selected.name}</span>
              <button onClick={() => { setSelected(null); setScoredData(null); setSpikes([]); setAnnotations([]); setZoomHours(null); }}
                style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 14 }}>✕</button>
            </div>
          )}
        </div>

        {/* Date range + fetch */}
        {selected && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <input type="datetime-local" value={dateRange.start} onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })} style={ss} />
            <span style={{ color: C.textDim, fontSize: 11 }}>to</span>
            <input type="datetime-local" value={dateRange.end} onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })} style={ss} />
            <div style={{ display: "flex", gap: 3 }}>
              {[{ label: "24h", h: 24 }, { label: "7d", h: 168 }, { label: "30d", h: 720 }].map((p) => (
                <button key={p.label} onClick={() => setPreset(p.h)}
                  style={{ padding: "4px 8px", fontSize: 9, fontWeight: 700, background: "transparent", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer" }}>{p.label}</button>
              ))}
            </div>
            <button onClick={fetchData} disabled={loading}
              style={{ ...ss, background: C.neonDim, color: C.neon, border: `1px solid ${C.neon}33`, cursor: "pointer", fontWeight: 700, marginLeft: "auto" }}>
              {loading ? "Loading..." : "Fetch Data"}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: "8px 12px", background: C.dangerDim, borderRadius: 8, color: C.danger, fontSize: 11, fontWeight: 600, marginBottom: 14 }}>
            ⚠️ {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ padding: 40, textAlign: "center", color: C.neon, fontSize: 12, animation: "pulse 1.5s infinite" }}>
            Fetching historical trades and computing suspicion scores...
          </div>
        )}

        {/* Timeline Chart */}
        {scoredData && !loading && (
          <>
            <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Volume & Suspicion Timeline — {chartData.length} data points
                </div>
                {spikes.length > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.danger }}>
                    {spikes.length} spike{spikes.length > 1 ? "s" : ""} detected
                  </span>
                )}
              </div>

              {/* Zoom controls */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                  <span style={{ fontSize: 9, color: C.textDim, marginRight: 4 }}>Zoom:</span>
                  {[
                    { label: "30m", h: 0.5 },
                    { label: "1h", h: 1 },
                    { label: "2h", h: 2 },
                    { label: "4h", h: 4 },
                    { label: "8h", h: 8 },
                    { label: "All", h: null },
                  ].map((z) => (
                    <button key={z.label} onClick={() => setZoomHours(z.h)}
                      style={{ padding: "3px 8px", fontSize: 9, fontWeight: 700, background: zoomHours === z.h ? C.neonDim : "transparent", color: zoomHours === z.h ? C.neon : C.textMuted, border: `1px solid ${zoomHours === z.h ? C.neon + "33" : C.border}`, borderRadius: 4, cursor: "pointer" }}>
                      {z.label}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 9, color: C.textDim }}>
                  {chartData.length} points · centered on {annotations.find((a) => a.auto) ? "close time" : "data end"}
                </span>
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 14, marginBottom: 6, paddingLeft: 4, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                  <span style={{ width: 14, height: 3, background: C.neon, borderRadius: 2 }} /> YES buys
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                  <span style={{ width: 14, height: 3, background: "#ff88cc", borderRadius: 2 }} /> NO buys
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                  <span style={{ width: 14, height: 3, background: C.blue, borderRadius: 2 }} /> Price (YES ¢)
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                  <span style={{ width: 14, height: 3, background: C.warning, borderRadius: 2, borderStyle: "dashed", borderWidth: 1, borderColor: C.warning }} /> 📰 News annotation
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                  <span style={{ width: 14, height: 3, background: "#ff5500", borderRadius: 2 }} /> 🔒 Result confirmed / betting stopped
                </span>
                {evidence.length > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: C.textMuted }}>
                    <span style={{ width: 14, height: 8, background: `${C.danger}20`, border: `1px solid ${C.danger}40`, borderRadius: 2 }} /> Insider gap (spike → news)
                  </span>
                )}
              </div>

              {/* Main chart: Volume + Price only */}
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  {/* No gradient defs needed — using solid fills with opacity */}
                  <XAxis dataKey="time" tick={{ fontSize: 7, fill: C.textDim }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="vol" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} width={35} label={{ value: "Volume", angle: -90, position: "insideLeft", fill: C.textDim, fontSize: 8 }} />
                  <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} width={35} domain={[0, 1]} label={{ value: "Price", angle: 90, position: "insideRight", fill: C.textDim, fontSize: 8 }} />
                  <Tooltip
                    contentStyle={{ background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 10, color: C.text }}
                    labelFormatter={(label) => `${label} UTC`}
                    formatter={(val, name) => {
                      if (name === "yesVol") return [val, "YES buys"];
                      if (name === "noVol") return [val, "NO buys"];
                      if (name === "price") return [typeof val === "number" ? `${(val * 100).toFixed(1)}¢` : "—", "Price"];
                      return [val, name];
                    }}
                  />

                  {/* News + settlement markers */}
                  {annotations.map((a) => {
                    const binTime = findClosestBinTime(a.ts, chartData);
                    if (!binTime) return null;
                    const isAuto = a.auto;
                    const color = isAuto ? "#ff5500" : C.warning;
                    const icon = isAuto ? "🔒" : "📰";
                    return <ReferenceLine key={a.id} x={binTime} yAxisId="vol" stroke={color} strokeWidth={isAuto ? 3 : 2} strokeDasharray={isAuto ? "none" : "6 3"}
                      label={{ value: `${icon}`, fill: color, fontSize: 12, fontWeight: 700, position: "top", offset: 4 }} />;
                  })}

                  {/* Evidence zones */}
                  {evidence.map((ev, i) => {
                    const spikeTime = findClosestBinTime(ev.spike.startTs, chartData);
                    const newsTime = findClosestBinTime(ev.annotation.ts, chartData);
                    if (!spikeTime || !newsTime) return null;
                    return <ReferenceArea key={i} x1={spikeTime} x2={newsTime} yAxisId="vol" fill={C.danger} fillOpacity={0.1} />;
                  })}

                  <Bar yAxisId="vol" dataKey="yesVol" fill={C.neon} fillOpacity={0.6} radius={[2, 2, 0, 0]} />
                  <Bar yAxisId="vol" dataKey="noVol" fill="#ff88cc" fillOpacity={0.6} radius={[2, 2, 0, 0]} />
                  <Line yAxisId="price" type="monotone" dataKey="price" stroke={C.blue} strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Suspicion heatmap strip — separate from volume chart */}
              <div style={{ marginTop: 4, marginBottom: 4 }}>
                <div style={{ fontSize: 8, color: C.textDim, marginBottom: 2, paddingLeft: 4 }}>SUSPICION SCORE</div>
                <div style={{ display: "flex", height: 14, borderRadius: 3, overflow: "hidden" }}>
                  {chartData.map((d, i) => (
                    <div key={i} style={{ flex: 1, background: d.suspicion > 20 ? susColor(d.suspicion) : C.border, opacity: d.suspicion > 20 ? 0.7 : 0.3 }}
                      title={`${d.time}: Sus ${d.suspicion}`} />
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 7, color: C.textDim, marginTop: 1 }}>
                  <span>{chartData[0]?.time}</span>
                  <span style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: "#335566" }}>■ Low</span>
                    <span style={{ color: "#ccaa00" }}>■ Elevated</span>
                    <span style={{ color: "#ff8800" }}>■ High</span>
                    <span style={{ color: "#ff0033" }}>■ Extreme</span>
                  </span>
                  <span>{chartData[chartData.length - 1]?.time}</span>
                </div>
              </div>
            </div>

            {/* Pre-Close Insider Analysis — only counts winning-side bets */}
            {selected?.result && selected?.closeTime && scoredData && (
              (() => {
                const closeTs = new Date(selected.closeTime).getTime();
                const winSide = selected.result; // "yes" or "no"
                const loseSide = winSide === "yes" ? "no" : "yes";
                const winColor = winSide === "yes" ? C.neon : "#ff88cc";
                const loseColor = winSide === "yes" ? "#ff88cc" : C.neon;

                // Analyze multiple time windows
                const windows = [
                  { label: "15 min", ms: 900000 },
                  { label: "30 min", ms: 1800000 },
                  { label: "1 hour", ms: 3600000 },
                  { label: "2 hours", ms: 7200000 },
                ];

                const analyses = windows.map((w) => {
                  const bins = scoredData.filter((b) => b.ts >= closeTs - w.ms && b.ts <= closeTs);
                  const winVol = bins.reduce((s, b) => s + (winSide === "yes" ? (b.yesVol || 0) : (b.noVol || 0)), 0);
                  const loseVol = bins.reduce((s, b) => s + (winSide === "yes" ? (b.noVol || 0) : (b.yesVol || 0)), 0);
                  const total = winVol + loseVol;
                  const prices = bins.filter((b) => b.price != null).map((b) => b.price);
                  const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0.5;
                  // For YES winners: profit = contracts × (1 - avg_price_paid)
                  // For NO winners: profit = contracts × avg_yes_price (since they bought NO cheap)
                  const costPerContract = winSide === "yes" ? avgPrice : (1 - avgPrice);
                  const profitPerContract = winSide === "yes" ? (1 - avgPrice) : avgPrice;
                  const amountWagered = Math.round(winVol * costPerContract);
                  const estProfit = Math.round(winVol * profitPerContract);
                  return { ...w, winVol, loseVol, total, avgPrice, costPerContract, profitPerContract, amountWagered, estProfit, pct: total > 0 ? Math.round((winVol / total) * 100) : 0 };
                });

                const best = analyses.find((a) => a.winVol > 0 && a.pct > 55) || analyses[2]; // default to 1h
                if (best.total === 0) return null;
                const insiderLikely = best.pct > 55 && best.winVol > 50;

                return (
                  <div style={{ background: insiderLikely ? `${C.danger}0a` : C.bgCard, border: `1px solid ${insiderLikely ? C.danger + "30" : C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: insiderLikely ? C.danger : C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                      {insiderLikely ? "🚨 Insider Trading Evidence" : "📊 Pre-Close Trading Analysis"} — Winning Side Only
                    </div>

                    {/* Time window breakdown */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 12 }}>
                      {analyses.map((a) => (
                        <div key={a.label} style={{ textAlign: "center", padding: "6px", background: a.pct > 55 ? `${C.danger}10` : C.bgElevated, borderRadius: 6, border: `1px solid ${a.pct > 55 ? C.danger + "30" : C.border}` }}>
                          <div style={{ fontSize: 8, color: C.textDim, marginBottom: 3 }}>Last {a.label}</div>
                          <div style={{ fontSize: 14, fontWeight: 800, fontFamily: "'Azeret Mono', monospace", color: a.pct > 55 ? C.danger : C.text }}>{a.winVol.toLocaleString()}</div>
                          <div style={{ fontSize: 8, color: winColor }}>winning {winSide.toUpperCase()} buys</div>
                          <div style={{ fontSize: 9, fontWeight: 700, fontFamily: "'Azeret Mono', monospace", color: C.textMuted, marginTop: 2 }}>${a.amountWagered.toLocaleString()} wagered</div>
                          <div style={{ fontSize: 8, color: a.pct > 55 ? C.danger : C.textDim }}>{a.pct}% of volume → ${a.estProfit.toLocaleString()} profit</div>
                        </div>
                      ))}
                    </div>

                    {/* Verdict */}
                    <div style={{ padding: "10px 12px", background: C.bgElevated, borderRadius: 6, fontSize: 11, lineHeight: 1.7 }}>
                      <div style={{ color: C.text, marginBottom: 4 }}>
                        This market resolved <span style={{ fontWeight: 800, color: winColor, fontSize: 13 }}>{winSide.toUpperCase()}</span>.
                      </div>
                      <div style={{ color: C.text }}>
                        In the final {best.label}, <span style={{ fontWeight: 800, color: winColor }}>{best.winVol.toLocaleString()}</span> contracts
                        were bought on the <span style={{ fontWeight: 700 }}>correct outcome</span> ({best.pct}% of all trades).
                        <span style={{ color: loseColor }}> {best.loseVol.toLocaleString()}</span> contracts were bought on the losing side.
                      </div>
                      {insiderLikely && best.estProfit > 0 && (
                        <div style={{ marginTop: 8, padding: "8px 10px", background: `${C.danger}12`, borderRadius: 4 }}>
                          <span style={{ color: C.danger, fontWeight: 800, fontSize: 12 }}>
                            Estimated profit from insider trades: <span style={{ fontSize: 16, fontFamily: "'Azeret Mono', monospace" }}>${best.estProfit.toLocaleString()}</span>
                          </span>
                          <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>
                            {best.winVol.toLocaleString()} winning contracts × ~{Math.round(best.profitPerContract * 100)}¢ profit each
                          </div>
                        </div>
                      )}
                      {!insiderLikely && (
                        <div style={{ marginTop: 6, color: C.textDim, fontSize: 10 }}>
                          Trading appears balanced — no strong evidence of insider activity in this window.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            )}

            {/* Detected Spikes */}
            {spikes.length > 0 && (
              <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                  Detected Spikes
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {spikes.map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: `${susColor(s.peakSuspicion)}08`, border: `1px solid ${susColor(s.peakSuspicion)}25`, borderRadius: 6 }}>
                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: `conic-gradient(${susColor(s.peakSuspicion)} ${s.peakSuspicion * 3.6}deg, ${C.border} 0deg)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <div style={{ width: 18, height: 18, borderRadius: "50%", background: C.bgCard, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: susColor(s.peakSuspicion), fontFamily: "'Azeret Mono', monospace" }}>{s.peakSuspicion}</div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{fmtTs(s.startTs)} — {fmtDuration(s.durationMins)} duration</div>
                        <div style={{ fontSize: 10, color: C.textMuted }}>Peak Z: {s.peakZ} · Peak Vol: {s.peakVolume} contracts · {susLabel(s.peakSuspicion)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* News Annotations */}
            <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                📰 News Annotations — Mark when news was published
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                <input type="text" placeholder='Headline (e.g. "US strikes Iran")' value={annoText} onChange={(e) => setAnnoText(e.target.value)}
                  style={{ ...ss, flex: "1 1 200px" }} />
                <input type="datetime-local" value={annoTime} onChange={(e) => setAnnoTime(e.target.value)} style={ss} />
                <button onClick={addAnnotation}
                  style={{ ...ss, background: C.neonDim, color: C.neon, border: `1px solid ${C.neon}33`, cursor: "pointer", fontWeight: 700 }}>
                  + Add
                </button>
              </div>
              {annotations.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {annotations.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: `${C.warning}08`, borderRadius: 4, border: `1px solid ${C.warning}15` }}>
                      <span style={{ fontSize: 11 }}>📰</span>
                      <span style={{ fontSize: 11, color: C.text, flex: 1 }}>{a.text}</span>
                      <span style={{ fontSize: 9, color: C.textMuted, fontFamily: "'Azeret Mono', monospace" }}>{fmtTs(a.ts)}</span>
                      <button onClick={() => removeAnnotation(a.id)} style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 12 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Evidence Summary */}
            {evidence.length > 0 && (
              <div style={{ background: `${C.danger}0a`, border: `1px solid ${C.danger}30`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: C.danger, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
                  🚨 Insider Trading Evidence
                </div>
                {evidence.map((ev, i) => (
                  <div key={i} style={{ padding: "10px 12px", background: C.bgCard, borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                      Volume spiked <span style={{ color: C.danger, fontFamily: "'Azeret Mono', monospace", fontWeight: 800, fontSize: 16 }}>{ev.gapMins}</span> minutes BEFORE news
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11 }}>
                      <div>
                        <div style={{ color: C.textMuted, marginBottom: 2 }}>⚡ Spike Start</div>
                        <div style={{ color: C.text, fontFamily: "'Azeret Mono', monospace", fontWeight: 600 }}>{fmtTs(ev.spike.startTs)}</div>
                        <div style={{ color: C.textDim, fontSize: 10, marginTop: 2 }}>
                          Suspicion: <span style={{ color: susColor(ev.spike.peakSuspicion), fontWeight: 700 }}>{ev.spike.peakSuspicion}</span> ({susLabel(ev.spike.peakSuspicion)})
                          · Z: {ev.spike.peakZ}
                        </div>
                      </div>
                      <div>
                        <div style={{ color: C.textMuted, marginBottom: 2 }}>📰 News Published</div>
                        <div style={{ color: C.text, fontFamily: "'Azeret Mono', monospace", fontWeight: 600 }}>{fmtTs(ev.annotation.ts)}</div>
                        <div style={{ color: C.textDim, fontSize: 10, marginTop: 2 }}>"{ev.annotation.text}"</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, padding: "6px 10px", background: `${C.danger}10`, borderRadius: 4, fontSize: 10, color: C.danger, fontWeight: 600 }}>
                      Conclusion: Trading activity preceded public information by {fmtDuration(ev.gapMins)}, suggesting access to non-public information.
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Empty state + Presets */}
        {!selected && !loading && results.length === 0 && (
          <div style={{ background: C.bgCard, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            <div style={{ padding: "30px 30px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🔬</div>
              <div style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>Search for a market or start with a known case study</div>
              <div style={{ fontSize: 10, color: C.textDim, maxWidth: 400, margin: "0 auto", lineHeight: 1.5 }}>
                The spike scanner runs our suspicion algorithm retroactively across historical trade data.
                Add news annotations to measure the gap between volume spikes and public information.
              </div>
            </div>
            <div style={{ padding: "0 14px 14px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, paddingLeft: 4 }}>
                Case Studies — Known Insider Activity Signals
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {PRESETS.map((p, i) => (
                  <div key={i} onClick={() => loadPreset(p)}
                    style={{ padding: "10px 12px", background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", transition: "border-color 0.15s" }}
                    onMouseEnter={(e) => e.currentTarget.style.borderColor = C.neon + "44"}
                    onMouseLeave={(e) => e.currentTarget.style.borderColor = C.border}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>{p.label}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.4 }}>{p.description}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <span style={{ fontSize: 8, padding: "2px 5px", borderRadius: 3, background: p.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: p.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700 }}>{p.venue}</span>
                      <span style={{ fontSize: 8, color: C.textDim }}>{p.dateStart.slice(0, 10)} → {p.dateEnd.slice(0, 10)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
