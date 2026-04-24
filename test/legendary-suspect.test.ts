/**
 * Diagnostic-only. Covers the near-miss screenshot branch added 2026-04-24:
 * encounters with text-delay close to (but under) the 3000ms shiny cutoff
 * save a PNG so the operator can review whether the cutoff is well-tuned.
 *
 * This deliberately does NOT test classification — the shiny decision still
 * lives in wild-hunt.evaluateTimingSignal and is covered by timing-detection.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { isSuspectDelay, writeSuspectIfNeeded } from '../src/engine/legendary-hunt';

describe('isSuspectDelay', () => {
  test('delayMs=2801 qualifies (absolute >= 2800 trigger)', () => {
    expect(isSuspectDelay(2801, 2000)).toBe(true);
  });

  test('delayMs=2800 qualifies at the boundary', () => {
    expect(isSuspectDelay(2800, 2000)).toBe(true);
  });

  test('delayMs=2500 with avg ~2200 does NOT qualify', () => {
    // 2500 < 2800 absolute, and 2500 <= 2200 + 500 = 2700 (strict >).
    expect(isSuspectDelay(2500, 2200)).toBe(false);
  });

  test('delayMs=2501 with avg=2000 qualifies via delta-over-avg', () => {
    // 2501 > 2000 + 500 = 2500 → delta trigger fires even under the 2800 floor.
    expect(isSuspectDelay(2501, 2000)).toBe(true);
  });

  test('delayMs=2500 with avg=0 (uncalibrated) does NOT qualify', () => {
    expect(isSuspectDelay(2500, 0)).toBe(false);
  });

  test('delayMs=0 or negative never qualifies', () => {
    expect(isSuspectDelay(0, 2000)).toBe(false);
    expect(isSuspectDelay(-5, 2000)).toBe(false);
  });
});

describe('writeSuspectIfNeeded', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiny-suspect-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('delayMs=2801 → suspect PNG written with expected name', async () => {
    const frame = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // png magic
    const written = await writeSuspectIfNeeded({
      lastFrame: frame,
      textDelayMs: 2801,
      avgDelay: 2000,
      target: 'mewtwo',
      attempts: 42,
      screenshotsDir: dir,
    });
    expect(written).not.toBeNull();
    expect(path.basename(written!)).toBe('legendary-suspect-mewtwo-42-delay2801.png');
    const stats = await fs.stat(written!);
    expect(stats.size).toBe(frame.length);
  });

  test('delayMs=2500 with avg ~2200 → no suspect PNG, directory stays empty', async () => {
    const frame = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const written = await writeSuspectIfNeeded({
      lastFrame: frame,
      textDelayMs: 2500,
      avgDelay: 2200,
      target: 'articuno',
      attempts: 7,
      screenshotsDir: dir,
    });
    expect(written).toBeNull();
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  test('null frame is a no-op even when delay qualifies', async () => {
    const written = await writeSuspectIfNeeded({
      lastFrame: null,
      textDelayMs: 2900,
      avgDelay: 2000,
      target: 'zapdos',
      attempts: 1,
      screenshotsDir: dir,
    });
    expect(written).toBeNull();
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });
});
