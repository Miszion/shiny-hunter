/**
 * Shared rolling text-appearance-delay calibration used by both wild and
 * legendary hunt engines. A battle's "appeared!" text delay vs the rolling
 * average is the signal that distinguishes a shiny (sparkle-animation-blocked
 * text) from a normal encounter.
 *
 * Both engines observe the same underlying game behavior, so they share one
 * history on disk. That way a legendary hunt picks up an already-warm average
 * from prior wild encounters instead of relaunching a 30-sample cold start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

const HISTORY_SIZE = 30;
const FILE_PATH = path.join(process.cwd(), 'data', 'delay-calibration.json');

interface PersistState {
  history: number[];
  updatedAt: number;
}

let history: number[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as PersistState;
    if (Array.isArray(parsed.history)) {
      history = parsed.history.filter((n) => typeof n === 'number' && n > 0 && n < 10000).slice(-HISTORY_SIZE);
      logger.info(`[DelayCalibration] loaded ${history.length} samples (avg=${Math.round(getAverage())}ms)`);
    }
  } catch {
    // No prior calibration on disk — start fresh
  }
}

function persist(): void {
  try {
    const dir = path.dirname(FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify({ history, updatedAt: Date.now() } satisfies PersistState));
  } catch (err) {
    logger.warn(`[DelayCalibration] persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function addSample(ms: number): void {
  ensureLoaded();
  if (!Number.isFinite(ms) || ms <= 0 || ms >= 5000) return;
  history.push(ms);
  if (history.length > HISTORY_SIZE) history.shift();
  persist();
}

export function getAverage(): number {
  ensureLoaded();
  if (history.length === 0) return 0;
  return history.reduce((a, b) => a + b, 0) / history.length;
}

export function getHistorySize(): number {
  ensureLoaded();
  return history.length;
}
