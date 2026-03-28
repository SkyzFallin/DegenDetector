# Security & Quality Audit (2026-03-28)

## Scope

- Front-end React/Vite application logic (`src/**`)
- Data ingestion from Polymarket and Kalshi public APIs (`src/api/**`)
- Dependency and build health (`package.json`, production build)

## What was checked

1. **Manual code review** for common client-side risks (XSS, insecure transport, unchecked parsing, unhandled error paths).
2. **Dependency vulnerability scan attempt** via `npm audit --audit-level=low`.
3. **Production build verification** via `npm run build`.

## Findings

### 1) Dependency vulnerability check is currently blocked in this environment

- `npm audit` failed with `403 Forbidden` against npm advisory bulk endpoint, so dependency CVEs could not be fully verified in this run.
- Risk level: **unknown until audit endpoint access is restored**.
- Recommendation:
  - Re-run `npm audit --audit-level=low` in CI with registry access.
  - Add automated checks in PR/CI pipeline.

### 2) No direct XSS sinks found in UI rendering

- Market/event strings are rendered through React JSX text nodes (escaped by default).
- No use of `dangerouslySetInnerHTML` observed.
- Risk level: **low**.

### 3) API error handling is resilient but observability can improve

- Fetch wrappers catch failures and return empty arrays, which avoids app crashes.
- However, users can get a degraded/empty experience without explicit venue-level error messaging beyond console logs.
- Risk level: **low-to-medium operational**.
- Recommendation:
  - Surface per-source fetch failures in UI (e.g., last error timestamp + retry state).

### 4) Performance warning in production bundle

- Build warns main JS chunk is over 500 kB after minification.
- Large bundles increase load time and can indirectly impact reliability on constrained devices.
- Risk level: **medium (performance/UX)**.
- Recommendation:
  - Add route/component code splitting and lazy-load heavy chart components.

## Improvements applied in this audit

1. **Recharts import tightened** from namespace import to named imports to improve tree-shaking potential.
2. **Deprecated string API usage removed** by replacing `substr` with `slice` in UID fallback helper.

## Suggested next actions (high impact)

1. Add CI job steps:
   - `npm ci`
   - `npm run build`
   - `npm audit --audit-level=moderate` (non-blocking first, then blocking)
2. Introduce linting/static checks (ESLint + `eslint-plugin-security` baseline rules).
3. Add lightweight runtime schema validation for external API payloads before mapping.
4. Split large UI bundle with `React.lazy` for detail/alerts panels.
