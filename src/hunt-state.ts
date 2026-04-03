import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const STATE_FILE = path.join(process.cwd(), 'data', 'hunt-state.json');

export interface PersistedHuntState {
  hunting: boolean;
  target: string;
  game: string;
  huntType: string;
  huntMode: string;
  encounters: number;
  startedAt: number | null;
  savedAt: number;
}

export function saveHuntState(state: PersistedHuntState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to save hunt state: ${msg}`);
  }
}

export function loadHuntState(): PersistedHuntState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as PersistedHuntState;
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to load hunt state: ${msg}`);
    return null;
  }
}

export function clearHuntState(): void {
  saveHuntState({
    hunting: false,
    target: '',
    game: '',
    huntType: '',
    huntMode: '',
    encounters: 0,
    startedAt: null,
    savedAt: Date.now(),
  });
}
