<p align="center">
  <img src="banner.svg" alt="DegenDetector - Insider Spike Detection" width="760"/>
</p>

Real-time volume anomaly detection dashboard for prediction markets. Monitors Polymarket and Kalshi for suspicious trading patterns that may indicate insider activity or information leaks.

**Author:** [SkyzFallin](https://github.com/SkyzFallin)

## What It Does

- Pulls live market data from **Polymarket** (Gamma API) and **Kalshi** (Events API)
- Computes a **Suspicion Score** (0-100) for each market based on six weighted signals:
  - Spike suddenness (volume ratio vs baseline)
  - Robust Z-score (MAD-based, outlier-resistant)
  - Directional conviction (one-sided buying)
  - Leak probability (by market category)
  - Off-hours activity (UTC-based)
  - News absence (heuristic — inferred from price stability)
- Fires alerts when multiple signals converge (Z >= 8, Suspicion >= 60, 2+ flags)
- Multi-select category filtering: Regulatory, Political, Financial, Legal, Geopolitical, Corporate
- Error banner with retry when API calls fail
- "Monitoring since" timestamp and manual refresh button

## Setup (Development)

```bash
git clone https://github.com/SkyzFallin/DegenDetector.git
cd DegenDetector
npm install
npm run dev
```

Opens at `http://localhost:5173`. The Vite dev proxy handles CORS for both APIs.

> **Note:** This tool is intended for local use only. It is not designed to be internet-exposed — run it on your own machine and access it at `http://localhost:5173`.

## Testing

The scoring logic (`src/scoring.js`) is fully covered by a unit test suite using [Vitest](https://vitest.dev/) — Vite's native test runner, zero extra config needed.

```bash
npm test          # run once
npm run test:watch  # re-run on file changes
```

Tests cover: `clamp`, `median`, `mad`, `robustZ`, `computeSuspicion`, `susColor`, `susLabel`, and the `priceFlip` signal. All functions are pure (no DOM, no state) so tests run in < 50 ms.

## How It Works

| Signal | Weight | What It Measures |
|---|---|---|
| Suddenness | 0-25 | Ratio of recent volume to baseline |
| Z-Score | 0-20 | Robust Z using median absolute deviation |
| Conviction | 0-20 | One-sided price movement (insider = directional) |
| Leak Prob | 0-15 | Category-based likelihood of pre-announcement leaks |
| Off-Hours | 0-10 | Activity during low-traffic UTC windows (22:00-06:00) |
| No News | 0-10 | Volume spike with no correlated news (heuristic) |

Volume is tracked in 1-minute bins over a 90-minute rolling window. Bins accumulate from polling deltas as the app runs — sparklines start flat and fill in over time.

## Tech Stack

- **Frontend:** React 18 + Recharts
- **Build:** Vite
- **Data:** Polymarket Gamma API + Kalshi REST API (public, no auth required)
- **Proxy:** Vite dev server proxy (handles CORS for all upstream APIs)

## License

[MIT](LICENSE)
