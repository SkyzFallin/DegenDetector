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
  - Off-hours activity
  - News absence
- Fires alerts when multiple signals converge (Z >= 8, Suspicion >= 60, 2+ flags)
- Multi-select category filtering: Regulatory, Political, Financial, Legal, Geopolitical, Corporate

## Setup

```bash
git clone https://github.com/SkyzFallin/DegenDetector.git
cd DegenDetector
npm install
npm run dev
```

Opens at `http://localhost:5173`. The Vite dev proxy handles CORS for both APIs.

## How It Works

| Signal | Weight | What It Measures |
|---|---|---|
| Suddenness | 0-25 | Ratio of recent volume to baseline (needs 10x+ to score) |
| Z-Score | 0-20 | Robust Z using median absolute deviation |
| Conviction | 0-20 | One-sided price movement (insider = directional) |
| Leak Prob | 0-15 | Category-based likelihood of pre-announcement leaks |
| Off-Hours | 0-10 | Activity during low-traffic windows (10pm-6am) |
| No News | 0-10 | Volume spike with no correlated news |

Volume is tracked in 1-minute bins over a 90-minute rolling window. Bins accumulate from polling deltas as the app runs.

## Tech Stack

- **Frontend:** React 18 + Recharts
- **Build:** Vite
- **Data:** Polymarket Gamma API + Kalshi REST API (public, no auth)
- **Proxy:** Vite dev server proxy (handles CORS)
