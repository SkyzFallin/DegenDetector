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

## Deploying to Production

> **Important:** The Vite dev proxy (`/api/poly`, `/api/kalshi`) only works during `npm run dev`. A production build is static files — API calls will 404 without a real proxy.

**Options (pick one):**

| Method | Complexity | Notes |
|---|---|---|
| **Vercel** | Low | Add `vercel.json` with [rewrites](https://vercel.com/docs/projects/project-configuration#rewrites) to proxy `/api/poly` and `/api/kalshi` |
| **Cloudflare Workers** | Low | Tiny worker that forwards requests to upstream APIs |
| **Nginx reverse proxy** | Medium | Standard `proxy_pass` rules for both API paths |
| **Express middleware** | Medium | `http-proxy-middleware` in a small Node server |

Example `vercel.json`:
```json
{
  "rewrites": [
    { "source": "/api/poly/:path*", "destination": "https://gamma-api.polymarket.com/:path*" },
    { "source": "/api/kalshi/:path*", "destination": "https://api.elections.kalshi.com/trade-api/v2/:path*" }
  ]
}
```

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
- **Proxy:** Vite dev server proxy (dev only — see Deploy section for production)

## License

[MIT](LICENSE)
