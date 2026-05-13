import { evaluateTimingSignal, makeShinyDecision } from '../src/engine/wild-hunt';

// The wild-hunt classifier uses a single 2800ms binary split for text-appearance
// delay, tightened from 3000ms on 2026-04-24 (Mewtwo noise ceiling was only
// 122ms below the old cutoff). Non-shiny calibration tops out at 2429ms; wild
// shinies still clear 2800 by 600ms+. Diagnostic screenshots for the near-miss
// band live in legendary-hunt.ts (see isSuspectDelay), not here.

describe('evaluateTimingSignal — 2800ms binary split', () => {
  const calibrated = { avgDelay: 2000, historySize: 30 };
  const uncalibrated = { avgDelay: 0, historySize: 2 };

  test('2801ms = shiny (boundary is strict >)', () => {
    const r = evaluateTimingSignal({ textDelayMs: 2801, ...calibrated, elapsedSinceBattle: 2801 });
    expect(r.signal).toBe('shiny');
    expect(r.debug).toContain('SHINY');
  });

  test('2800ms = normal (boundary is strict >)', () => {
    const r = evaluateTimingSignal({ textDelayMs: 2800, ...calibrated, elapsedSinceBattle: 2800 });
    expect(r.signal).toBe('normal');
    expect(r.debug).toContain('normal');
  });

  test('3001ms = shiny (well above cutoff)', () => {
    const r = evaluateTimingSignal({ textDelayMs: 3001, ...calibrated, elapsedSinceBattle: 3001 });
    expect(r.signal).toBe('shiny');
    expect(r.debug).toContain('SHINY');
  });

  test('2500ms = normal', () => {
    const r = evaluateTimingSignal({ textDelayMs: 2500, ...calibrated, elapsedSinceBattle: 2500 });
    expect(r.signal).toBe('normal');
  });

  test('shiny classification works without calibration baseline', () => {
    const r = evaluateTimingSignal({ textDelayMs: 4000, ...uncalibrated, elapsedSinceBattle: 4000 });
    expect(r.signal).toBe('shiny');
  });

  test('debug line exposes deviation when baseline is available', () => {
    const r = evaluateTimingSignal({ textDelayMs: 3200, ...calibrated, elapsedSinceBattle: 3200 });
    expect(r.debug).toMatch(/avg=2000ms/);
    expect(r.debug).toMatch(/dev=\+1200ms/);
  });

  test('typical normal (delay ~2050ms, avg ~2000ms)', () => {
    const r = evaluateTimingSignal({ textDelayMs: 2050, ...calibrated, elapsedSinceBattle: 2050 });
    expect(r.signal).toBe('normal');
  });

  test('worst observed normal (2429ms) still classifies as normal', () => {
    const r = evaluateTimingSignal({ textDelayMs: 2429, ...calibrated, elapsedSinceBattle: 2429 });
    expect(r.signal).toBe('normal');
  });
});

describe('evaluateTimingSignal — no-text fallback', () => {
  const calibrated = { avgDelay: 2000, historySize: 30 };

  test('>4500ms with no text = shiny (sparkle animation still blocking render)', () => {
    const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 5000 });
    expect(r.signal).toBe('shiny');
    expect(r.debug).toContain('NO TEXT');
  });

  test('exactly 4500ms = inconclusive (not shiny yet)', () => {
    const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 4500 });
    expect(r.signal).toBe('inconclusive');
    expect(r.debug).toContain('not detected');
  });

  test('<4500ms with no text = inconclusive (still rendering)', () => {
    const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 3000 });
    expect(r.signal).toBe('inconclusive');
  });
});

describe('makeShinyDecision', () => {
  test('normal timing → not shiny', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'normal' });
    expect(isShiny).toBe(false);
    expect(signals).toEqual([]);
  });

  test('shiny timing → shiny, signals=["timing"]', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'shiny' });
    expect(isShiny).toBe(true);
    expect(signals).toEqual(['timing']);
  });

  test('inconclusive timing → not shiny', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'inconclusive' });
    expect(isShiny).toBe(false);
    expect(signals).toEqual([]);
  });
});
