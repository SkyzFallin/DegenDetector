import { useState, useCallback, useMemo } from "react";
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
  const fetchData = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setScoredData(null);
    setSpikes([]);

    const startMs = new Date(dateRange.start).getTime();
    const endMs = new Date(dateRange.end).getTime();

    if (endMs <= startMs) {
      setError("End date must be after start date.");
      setLoading(false);
      return;
    }

    try {
      let bins;
      if (selected.venue === "Kalshi") {
        const trades = await fetchKalshiTrades(selected.ticker, startMs, endMs);
        if (trades.length === 0) {
          setError("No trades found in this date range.");
          setLoading(false);
          return;
        }
        bins = binKalshiTrades(trades, startMs, endMs);
      } else {
        const prices = await fetchPolyPriceHistory(selected.tokenId, startMs, endMs);
        if (prices.length === 0) {
          setError("No price data found. Polymarket may have limited history for resolved markets.");
          setLoading(false);
          return;
        }
        bins = binPolyPrices(prices, startMs, endMs);
      }

      const scored = computeRetroactiveScores(bins, { category: selected.category });
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

  // ─── Chart data (downsample if too many points) ───────────
  const chartData = useMemo(() => {
    if (!scoredData) return [];
    // For ranges > 2 days, downsample to 5-min bins
    if (scoredData.length > 2880) {
      const step = Math.ceil(scoredData.length / 1440);
      return scoredData.filter((_, i) => i % step === 0);
    }
    return scoredData;
  }, [scoredData]);

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
            <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 240, overflowY: "auto" }}>
              {results.map((m) => (
                <div key={m.id} onClick={() => { setSelected(m); setResults([]); }}
                  style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}
                  onMouseEnter={(e) => e.currentTarget.style.background = C.bgCardHover}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: m.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: m.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700, textTransform: "uppercase" }}>{m.venue}</span>
                  <span style={{ fontSize: 11, color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                  <span style={{ fontSize: 9, color: C.textDim }}>{m.status}</span>
                </div>
              ))}
            </div>
          )}

          {/* Selected market */}
          {selected && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: selected.venue === "Polymarket" ? `${C.poly}14` : `${C.kalshi}14`, color: selected.venue === "Polymarket" ? C.poly : C.kalshi, fontWeight: 700, textTransform: "uppercase" }}>{selected.venue}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, flex: 1 }}>{selected.name}</span>
              <button onClick={() => { setSelected(null); setScoredData(null); setSpikes([]); setAnnotations([]); }}
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

              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                  <defs>
                    <linearGradient id="histVol" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.neon} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={C.neon} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="vol" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} width={35} />
                  <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 8, fill: C.textDim }} axisLine={false} tickLine={false} width={35} domain={[0, 1]} />
                  <Tooltip
                    contentStyle={{ background: C.bgElevated, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 10, color: C.text }}
                    formatter={(val, name) => {
                      if (name === "volume") return [val, "Volume"];
                      if (name === "price") return [typeof val === "number" ? `${(val * 100).toFixed(1)}¢` : "—", "Price"];
                      if (name === "suspicion") return [val, "Suspicion"];
                      return [val, name];
                    }}
                  />

                  {/* News annotation markers */}
                  {annotations.map((a) => {
                    const timeStr = new Date(a.ts).toISOString().slice(11, 16);
                    return <ReferenceLine key={a.id} x={timeStr} yAxisId="vol" stroke={C.warning} strokeDasharray="4 4" label={{ value: `📰 ${a.text.slice(0, 20)}`, fill: C.warning, fontSize: 8, position: "top" }} />;
                  })}

                  {/* Evidence zones — red shading between spike start and news */}
                  {evidence.map((ev, i) => {
                    const spikeTime = new Date(ev.spike.startTs).toISOString().slice(11, 16);
                    const newsTime = new Date(ev.annotation.ts).toISOString().slice(11, 16);
                    return <ReferenceArea key={i} x1={spikeTime} x2={newsTime} yAxisId="vol" fill={C.danger} fillOpacity={0.08} />;
                  })}

                  <Area yAxisId="vol" type="monotone" dataKey="volume" stroke={C.neon} fill="url(#histVol)" strokeWidth={1} dot={false} />
                  <Line yAxisId="price" type="monotone" dataKey="price" stroke={C.blue} strokeWidth={1} dot={false} connectNulls />
                  <Bar yAxisId="vol" dataKey="suspicion" opacity={0.6} radius={[1, 1, 0, 0]}>
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={susColor(d.suspicion)} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>

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

        {/* Empty state */}
        {!selected && !loading && (
          <div style={{ padding: 50, textAlign: "center", color: C.textDim, background: C.bgCard, borderRadius: 12, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔬</div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Search for a market to analyze historical trading patterns</div>
            <div style={{ fontSize: 10, maxWidth: 400, margin: "0 auto", lineHeight: 1.5 }}>
              The spike scanner runs our suspicion algorithm retroactively across historical trade data.
              Add news annotations to measure the gap between volume spikes and public information — proving insider activity.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
