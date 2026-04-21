/**
 * LegendaryHuntEngine — scaffold for stationary-legendary soft-reset hunting.
 *
 * Target: Articuno / Zapdos / Moltres / Mewtwo in FRLG (and any other single
 * stationary encounter added to sequences.ts).
 *
 * Flow (per attempt, ~18-20s wallclock):
 *   1. SOFT_RESET — softReset() via ESP32
 *   2. WAIT_BOOT — 2500ms BIOS / boot
 *   3. TITLE_AND_LOAD — canonical title + load-save + B-spam recap
 *   4. ENGAGE — single A press to trigger the wild-battle intro
 *   5. DETECT — poll capture-card frames for battle sparkle (isBattleScreen
 *      + detectBattleSparkle). Non-shiny encounters have no sparkle cluster;
 *      shiny encounters show small (4-150px) near-white clusters over ~2s.
 *   6. On shiny → save frame, stop for manual catch. On non-shiny → RESET.
 *
 * Why this can't beat baseline 1/8192: on a Switch that doesn't expose
 * save states, we cannot freeze PRNG state. Every attempt rolls a fresh
 * PID at encounter-trigger time. The only improvement over Lapras is the
 * shorter cycle time (no long gift-NPC dialog), giving ~2-3× wallclock
 * speedup on the expected-time-to-shiny for the same odds.
 *
 * Where this engine differs from StaticHuntEngine:
 *   - No OPEN_SUMMARY / summary OCR (legendaries can't be fled from in Gen 3,
 *     so we detect before committing to a catch).
 *   - No stats/IV extraction during the hunt (summary is never opened).
 *     If IV calibration is needed for a specific legendary's advance window,
 *     we'd catch the shiny manually and read stats post-hunt.
 *   - Interact sequence is a single A press (FRLG_LEGENDARY_INTERACT), not
 *     a multi-textbox dialog mash.
 *
 * Environment assumption: `HUNT_ENV=switch` + ESP32 serial + MiraBox capture,
 * same as StaticHuntEngine. Pre-condition: player saved facing the legendary
 * so one A press triggers the encounter.
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, ButtonSequence } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { getStaticSequences } from './sequences';
import { isBattleScreen, detectBattleSparkle } from '../detection/battle-shiny';
import { extractBattleInfo } from '../detection/battle-info';
import { evaluateTimingSignal } from './wild-hunt';

type LegendaryState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TITLE_AND_LOAD'
  | 'ENGAGE'
  | 'DETECT'
  | 'SHINY_FOUND'
  | 'RESET';

// How long to watch for sparkle after the battle screen renders.
// FRLG shiny sparkle animation plays for ~1.5 seconds after "Wild X appeared!"
// so we scan for 2.5s total to be safe.
const SPARKLE_SCAN_MS = 2500;
const SPARKLE_POLL_INTERVAL_MS = 150;
const BATTLE_DETECT_TIMEOUT_MS = 15_000;

export class LegendaryHuntEngine extends EventEmitter {
  private state: LegendaryState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;

  public encounterLog: Array<{
    attempt: number;
    time: number;
    isShiny: boolean;
    debug: string;
    textDelayMs?: number;
  }> = [];

  // Rolling average of text-appearance delay, used to detect shiny via
  // delay-based signal (same approach wild-hunt uses).
  private textDelayHistory: number[] = [];
  private readonly HISTORY_MAX = 30;

  private getAverageTextDelay(): number {
    if (this.textDelayHistory.length === 0) return 0;
    const sum = this.textDelayHistory.reduce((a, b) => a + b, 0);
    return sum / this.textDelayHistory.length;
  }

  private addTextDelaySample(ms: number): void {
    this.textDelayHistory.push(ms);
    if (this.textDelayHistory.length > this.HISTORY_MAX) this.textDelayHistory.shift();
  }

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
  }

  getStatus(): HuntStatus {
    const now = Date.now();
    const elapsed = this.startedAt ? (now - this.startedAt) / 1000 : 0;
    return {
      state: this.state as any,
      encounters: this.attempts,
      target: this.target,
      game: this.game,
      startedAt: this.startedAt,
      elapsedSeconds: elapsed,
      encountersPerHour: elapsed > 0 ? Math.round((this.attempts / elapsed) * 3600) : 0,
      running: this.running,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    logger.info(`[Legendary] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Legendary] Pre-condition: player saved FACING ${this.target}, one A press triggers battle.`);
    this.running = true;
    this.attempts = 0;
    this.startedAt = Date.now();
    this.state = 'SOFT_RESET';
    this.emit('started', this.getStatus());
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Legendary] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[Legendary] Stopping after ${this.attempts} attempts`);
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'SOFT_RESET':
        await this.input.softReset();
        this.state = 'WAIT_BOOT';
        break;
      case 'WAIT_BOOT':
        await this.wait(config.env === 'switch' ? 2500 : 3000);
        this.state = 'TITLE_AND_LOAD';
        break;
      case 'TITLE_AND_LOAD':
        await this.titleAndLoad();
        break;
      case 'ENGAGE':
        await this.engage();
        break;
      case 'DETECT':
        await this.detectBattleResult();
        break;
      case 'SHINY_FOUND':
        logger.info('[Legendary] *** SHINY FOUND — stopping for manual catch ***');
        this.stop();
        break;
      case 'RESET':
        this.state = 'SOFT_RESET';
        break;
      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  private async titleAndLoad(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);
    await this.executeSequence(seqs.title);
    await this.executeSequence(seqs.loadSave);
    // B-spam through recap (save-recap dialogue after CONTINUE)
    for (let i = 0; i < 20 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(150);
    }
    await this.wait(400);
    this.state = 'ENGAGE';
  }

  private async engage(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);
    await this.executeSequence(seqs.interact);
    this.state = 'DETECT';
  }

  /**
   * Detect shiny via the same timing signal wild-hunt uses: the GBA
   * architecturally blocks "Wild X appeared!" text rendering until the
   * shiny sparkle animation completes (~80 frames / ~1.3s extra).
   *
   * Normal legendary:  text appears ~1.7-2.5s after battle screen starts
   * Shiny legendary:   text appears ~3.0-3.8s after battle screen starts
   *
   * We poll capture-card frames, run OCR on the text box to find when
   * "appeared!" text renders, and compare delay against a rolling
   * average. Also use detectBattleSparkle as a secondary confirming
   * signal when delay is borderline.
   */
  private async detectBattleResult(): Promise<void> {
    this.attempts++;

    // Step 1: wait for battle screen to render
    const battleDeadline = Date.now() + BATTLE_DETECT_TIMEOUT_MS;
    let onBattle = false;
    let battleDetectedAt = 0;
    while (Date.now() < battleDeadline && this.running) {
      const frame = await this.frameSource.captureFrame();
      if (await isBattleScreen(frame)) {
        onBattle = true;
        battleDetectedAt = Date.now();
        break;
      }
      await this.wait(150);
    }

    if (!onBattle) {
      logger.warn(`[Legendary] Attempt #${this.attempts} — battle screen never appeared. Resetting.`);
      this.encounterLog.push({
        attempt: this.attempts, time: Date.now(), isShiny: false,
        debug: 'battle-screen-timeout',
      });
      this.state = 'RESET';
      return;
    }

    // Step 2: poll frames looking for "appeared!" text + sparkle as a backup.
    // OCR won't find text before ~800ms (still animating in). Stop at 5s
    // before the player's own Pokemon entry sparkle can confuse us.
    let textAppearedAt: number | null = null;
    let textDelayMs = 0;
    let maxSparkleCount = 0;
    let maxSparkleDebug = '';
    let lastFrame: Buffer | null = null;

    const pollStart = Date.now();
    const MAX_POLL_MS = 5000;
    const OCR_START_DELAY = 800;

    while (Date.now() - pollStart < MAX_POLL_MS && this.running && !textAppearedAt) {
      try {
        const frame = await this.frameSource.captureFrame();
        lastFrame = frame;
        const elapsed = Date.now() - battleDetectedAt;

        // Sparkle sampling (secondary signal)
        const sp = await detectBattleSparkle(frame);
        if (sp.sparkleCount > maxSparkleCount) {
          maxSparkleCount = sp.sparkleCount;
          maxSparkleDebug = `sparkleCount=${sp.sparkleCount} maxCluster=${sp.maxClusterSize}`;
        }

        // OCR after 800ms to find "appeared!" text
        if (elapsed >= OCR_START_DELAY) {
          try {
            const info = await extractBattleInfo(frame);
            if (info.species) {
              textAppearedAt = Date.now();
              textDelayMs = textAppearedAt - battleDetectedAt;
              break;
            }
          } catch {}
        }
      } catch {}
      await this.wait(200);
    }

    // Step 3: evaluate timing signal
    const timingResult = evaluateTimingSignal({
      textDelayMs: (textAppearedAt && textDelayMs > 0) ? textDelayMs : null,
      avgDelay: this.getAverageTextDelay(),
      historySize: this.textDelayHistory.length,
      elapsedSinceBattle: Date.now() - battleDetectedAt,
    });

    const isShiny = timingResult.signal === 'shiny';

    // Log line matches wild-hunt format for consistency
    const debugParts = [timingResult.debug];
    if (maxSparkleCount > 0) debugParts.push(maxSparkleDebug);
    const debug = debugParts.join(' | ');

    if (isShiny) {
      const ts = Date.now();
      const screenshotPath = path.join(process.cwd(), config.paths.screenshots,
        `legendary-shiny-${this.target}-${ts}.png`);
      if (lastFrame) await fs.writeFile(screenshotPath, lastFrame);
      logger.info(`[Legendary] Attempt #${this.attempts} *** SHINY! *** [timing] | ${debug}`);
      logger.info(`[Legendary] *** SHINY FOUND! Do NOT press anything — catch it manually! ***`);
      logger.info(`[Legendary] Saved: ${screenshotPath}`);
      this.encounterLog.push({
        attempt: this.attempts, time: Date.now(), isShiny: true,
        debug, textDelayMs: textDelayMs || undefined,
      });
      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        debug,
        textDelayMs: textDelayMs || undefined,
      });
      this.state = 'SHINY_FOUND';
      return;
    }

    // Non-shiny — update rolling delay average (only for normal/inconclusive
    // where we got a clean text-delay reading under 5s)
    if (textDelayMs > 0 && textDelayMs < 5000) {
      this.addTextDelaySample(textDelayMs);
    }

    logger.info(`[Legendary] Encounter #${this.attempts}: ${timingResult.signal} | ${this.target} | ${debug}`);
    this.encounterLog.push({
      attempt: this.attempts, time: Date.now(), isShiny: false,
      debug, textDelayMs: textDelayMs || undefined,
    });
    if (lastFrame && this.attempts % 100 === 1) {
      try {
        const debugPath = path.join(process.cwd(), config.paths.screenshots,
          `legendary-${this.target}-${this.attempts}-${Date.now()}.png`);
        fs.writeFile(debugPath, lastFrame).catch(() => {});
      } catch {}
    }
    if (this.attempts % 100 === 0) this.emit('milestone', this.getStatus());
    this.state = 'RESET';
  }

  private async executeSequence(sequence: ButtonSequence): Promise<void> {
    for (const step of sequence) {
      if (!this.running) return;
      switch (step.action) {
        case 'press':
          await this.input.pressButton(step.keys[0] as any, step.holdMs ?? 50);
          break;
        case 'mashA':
          for (let i = 0; i < step.count && this.running; i++) {
            await this.input.pressButton('A', 50);
            await this.wait(step.intervalMs ?? 500);
          }
          break;
        case 'wait':
          await this.wait(step.ms);
          break;
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
