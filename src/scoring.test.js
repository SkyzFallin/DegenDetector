import { describe, it, expect } from 'vitest';
import {
  clamp,
  median,
  mad,
  robustZ,
  computeSuspicion,
  susColor,
  susLabel,
} from './scoring.js';

// ─── Helper to build a minimal market object ─────────────────────
const makeMarket = (overrides = {}) => ({
  bins: new Array(90).fill(5),           // baseline
  price: 0.6,
  baselinePrice: 0.5,
  priceChange: 0.12,
  leakProb: 0.6,
  hasRecentNews: false,
  walletRisk: { walletRiskScore: 0.8 },
  baseVolume: 10,
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────
describe('scoring.js utilities', () => {
  it('clamp works', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
  });

  it('median & mad handle edge cases', () => {
    expect(median([])).toBe(0);
    expect(mad([])).toBe(0);
    expect(median([1, 3, 3, 6, 7, 8, 9])).toBe(6);
  });

  it('robustZ is outlier-resistant', () => {
    const win = [5, 5, 5, 5, 50];           // one spike
    expect(robustZ(50, win)).toBeGreaterThan(10); // strong positive Z
    expect(robustZ(5, win)).toBeCloseTo(0, 1);    // normal value ≈ 0
  });

  it('computeSuspicion returns 0-100 and reacts to signals', () => {
    const baseline = makeMarket({ bins: Array(90).fill(5) });
    const score = computeSuspicion(baseline);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    // Spike + no news + wallet risk = very high score
    const degen = makeMarket({
      bins: [...Array(85).fill(5), ...Array(5).fill(120)],
      priceChange: 0.25,
      hasRecentNews: false,
      walletRisk: { walletRiskScore: 1 },
    });
    const degenScore = computeSuspicion(degen);
    expect(degenScore).toBeGreaterThan(65); // should be HIGH or EXTREME
  });

  it('susColor and susLabel match thresholds', () => {
    expect(susColor(85)).toBe('#ff0033');
    expect(susLabel(85)).toBe('EXTREME');
    expect(susColor(45)).toBe('#ff8800'); // sus60 — ELEVATED
    expect(susLabel(25)).toBe('LOW');
  });

  it('priceFlip component activates on large moves', () => {
    const flipMarket = makeMarket({
      price: 0.95,
      baselinePrice: 0.4,
      bins: [...Array(88).fill(3), ...Array(2).fill(80)],
    });
    const score = computeSuspicion(flipMarket);
    expect(score).toBeGreaterThan(60); // price-flip bonus should push it high
  });
});
