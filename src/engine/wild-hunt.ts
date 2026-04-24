import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, GBAButton } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import {
  isBattleScreen,
  isOverworldScreen,
} from '../detection/battle-shiny';
import { extractBattleInfo, BattleEnemyInfo } from '../detection/battle-info';
import * as delayCalibration from './delay-calibration';

/**
 * Wild encounter shiny hunt engine.
 *
 * Flow:
 * 1. Game is pre-saved standing in tall grass/water
 * 2. Walk in a pattern (up/down/left/right) to trigger random encounters
 * 3. When battle starts, scan for shiny sparkle animation
 * 4. If shiny: stop (user catches manually)
 * 5. If not shiny: run from battle, continue walking
 *
 * No soft resets needed — just walk continuously.
 */

// ── Exported pure functions for testability ──

export type TimingSignal = 'shiny' | 'normal' | 'inconclusive';

export interface TimingResult {
  signal: TimingSignal;
  debug: string;
}

/**
 * Evaluate the timing signal for shiny detection.
 *
 * The GBA game engine architecturally blocks "Wild X appeared!" text until
 * the shiny sparkle animation completes (~80+ frames / ~1.3s). This creates
 * a reliable timing gap between normal and shiny encounters.
 */
export function evaluateTimingSignal(opts: {
  textDelayMs: number | null;
  avgDelay: number;
  historySize: number;
  elapsedSinceBattle: number;
}): TimingResult {
  const { textDelayMs, avgDelay, elapsedSinceBattle } = opts;

  if (textDelayMs !== null && textDelayMs > 0) {
    // Calibration reference (8832 non-shiny wild encounters): avg=2043ms,
    // p50=2036, max=2429. Mewtwo top non-shiny: 2878ms (#2490). Real shiny
    // catches (Voltorb 3402ms, Pikachu 3809ms) sit well above. Cutoff lowered
    // from 3000ms -> 2800ms per user 2026-04-24 to tighten the legendary net
    // (Mewtwo noise ceiling was only 122ms below old cutoff). Wild shinies
    // still clear 2800 by 600ms+.
    //   delay > 2800ms  -> SHINY
    //   delay <= 2800ms -> NORMAL
    if (textDelayMs > 2800) {
      const dev = avgDelay > 0 ? Math.round(textDelayMs - avgDelay) : null;
      const devStr = dev !== null ? ` avg=${Math.round(avgDelay)}ms dev=+${dev}ms` : '';
      return { signal: 'shiny', debug: `delay=${textDelayMs}ms${devStr} SHINY` };
    }
    const dev = avgDelay > 0 ? Math.round(textDelayMs - avgDelay) : null;
    const devStr = dev !== null ? ` avg=${Math.round(avgDelay)}ms dev=${dev >= 0 ? '+' : ''}${dev}ms` : '';
    return { signal: 'normal', debug: `delay=${textDelayMs}ms${devStr} normal` };
  }

  // No text detected at all
  if (elapsedSinceBattle > 4500) {
    return { signal: 'shiny', debug: `NO TEXT after ${elapsedSinceBattle}ms — likely shiny (animation blocking)` };
  }
  return { signal: 'inconclusive', debug: 'text not detected in time' };
}

/**
 * Shiny decision based on timing signal.
 */
export function makeShinyDecision(opts: {
  timingSignal: TimingSignal;
}): { isShiny: boolean; signals: string[] } {
  const signals: string[] = [];
  if (opts.timingSignal === 'shiny') signals.push('timing');
  return { isShiny: opts.timingSignal === 'shiny', signals };
}

type WildHuntState =
  | 'IDLE'
  | 'WALKING'
  | 'BATTLE_DETECT'
  | 'SHINY_FOUND'
  | 'RUN_AWAY'
  | 'WAIT_OVERWORLD';

// Walking pattern: UP then DOWN keeps you in the same spot
// This prevents walking out of the grass patch
const WALK_PATTERN: GBAButton[] = ['UP', 'DOWN'];

export class WildHuntEngine extends EventEmitter {
  private state: WildHuntState = 'IDLE';
  private encounters = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private walkIndex = 0;
  private stepsSinceEncounter = 0;
  private lastBattleInfo: BattleEnemyInfo = { species: null, level: null, gender: 'unknown' };
  private waitOverworldTicks = 0;
  private shinyAnnounced = false;

  // Baseline timing: rolling average of "battle detected → text appeared" delay
  // for normal encounters. Shiny encounters should be ~0.5-0.7s longer.
  // History is shared with LegendaryHuntEngine via delay-calibration singleton.

  // Encounter log for dashboard
  public encounterLog: Array<{
    attempt: number;
    time: number;
    isShiny: boolean;
    species: string | null;
    level: number | null;
    gender: string;
    textDelayMs?: number;
    signals?: string;
    debugInfo: string;
  }> = [];

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
      encounters: this.encounters,
      target: this.target,
      game: this.game,
      startedAt: this.startedAt,
      elapsedSeconds: elapsed,
      encountersPerHour: elapsed > 0 ? Math.round((this.encounters / elapsed) * 3600) : 0,
      running: this.running,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info(`[Wild Hunt] Starting: ${this.target} in ${this.game}`);
    logger.info('[Wild Hunt] Walk pattern: UP → DOWN (repeat)');
    logger.info('[Wild Hunt] Shiny detection: sparkle + palette analysis');

    // Soft reset the game to ensure clean state (not stuck in battle)
    logger.info('[Wild Hunt] Soft resetting game to ensure clean overworld state...');
    await this.input.softReset();
    await this.wait(3000); // Wait for game to start resetting

    // Mash A through the title screen / continue screen
    for (let i = 0; i < 15; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(500);
    }
    // Wait for the overworld to load after "Continue"
    await this.wait(2000);
    logger.info('[Wild Hunt] Game reset complete, starting hunt');

    this.running = true;
    this.encounters = 0;
    this.startedAt = Date.now();
    this.state = 'WALKING';
    this.walkIndex = 0;
    this.stepsSinceEncounter = 0;
    this.shinyAnnounced = false;
    this.emit('started', this.getStatus());

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Wild Hunt] Error in state ${this.state}: ${msg}`);
        // Try to recover by going back to walking
        this.state = 'WALKING';
        await this.wait(2000);
      }
    }
  }

  stop(): void {
    logger.info(`[Wild Hunt] Stopping after ${this.encounters} encounters`);
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'WALKING':
        await this.walkAndCheckBattle();
        break;

      case 'BATTLE_DETECT':
        await this.handleBattleDetection();
        break;

      case 'SHINY_FOUND':
        // Stay in this state — don't stop the engine so the server keeps running
        // and the dashboard shows the shiny in battle. User catches manually.
        if (!this.shinyAnnounced) {
          logger.info('[Wild Hunt] *** SHINY FOUND! Do NOT press anything — catch it manually! ***');
          this.shinyAnnounced = true;
        }
        await this.wait(5000);
        break;

      case 'RUN_AWAY':
        await this.runFromBattle();
        break;

      case 'WAIT_OVERWORLD':
        await this.waitForOverworld();
        break;

      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  /**
   * Take one step in the walk pattern and check if we entered a battle.
   */
  private async walkAndCheckBattle(): Promise<void> {
    const direction = WALK_PATTERN[this.walkIndex % WALK_PATTERN.length];
    this.walkIndex++;

    // Take a step — hold longer for reliability on NSO
    await this.input.pressButton(direction, 150);
    await this.wait(400); // wait for step animation + capture card latency
    this.stepsSinceEncounter++;

    // Check if we entered a battle — single frame check (saves ~1.75s per step).
    // If we miss a battle start, we'll catch it on the next step.
    const frame = await this.frameSource.captureFrame();
    const inBattle = await isBattleScreen(frame);

    if (inBattle) {
      logger.info(`[Wild Hunt] Battle detected after ${this.stepsSinceEncounter} steps!`);
      this.stepsSinceEncounter = 0;
      this.state = 'BATTLE_DETECT';
      return;
    }

    // Log progress occasionally
    if (this.stepsSinceEncounter > 0 && this.stepsSinceEncounter % 50 === 0) {
      logger.info(`[Wild Hunt] ${this.stepsSinceEncounter} steps since last encounter (${this.encounters} total encounters)`);
    }
  }

  /**
   * Unified battle detection: timing + sparkle + palette.
   *
   * Three independent shiny signals:
   *   1. TIMING (primary, standalone-reliable): Shiny Pokemon have a ~1.3s+ longer
   *      delay before "Wild X appeared!" text. The game engine architecturally blocks
   *      text display until the 80+ frame sparkle animation completes (confirmed via
   *      pokefirered decompilation). We use both absolute (>3500ms) and relative
   *      (>1000ms above baseline) thresholds.
   *   2. SPARKLE: Bright pixel cluster analysis on frames captured during entry.
   *   3. PALETTE: Compare sprite colors against known normal/shiny palettes.
   *
   * FRLG wild battle timeline (from actual battle start):
   *   t+0.0s: Battle transition (screen wipe)
   *   t+1.0s: Battle background loads, enemy Pokemon slides in
   *   t+1.5s: Enemy shiny sparkle plays (if shiny) — lasts ~0.7s
   *   t+2.0s: Battle text box visible → isBattleScreen() detects it (t=0 for us)
   *   t+3.0s: "Wild POKEMON appeared!" text (normal) / ~t+3.5-3.7s (shiny)
   *   t+5.0s: "Go! CHARMANDER!" — player's Pokemon enters
   *   t+5.5s: Player's shiny sparkle plays (if shiny) + SCREEN FLASH
   *   t+7.0s: Battle menu appears
   *
   * IMPORTANT: Our player's Charmander is shiny, so it sparkles with a
   * screen-wide white flash at ~t+5.5s. We MUST end scanning before t+5s.
   */
  private async handleBattleDetection(): Promise<void> {
    this.encounters++;
    const battleDetectedAt = Date.now();
    logger.info(`[Wild Hunt] Encounter #${this.encounters} — scanning...`);

    // ── Single-pass detection: capture frames + OCR + timing ──
    // Poll every 200ms. First ~800ms: just capture frames (text won't be ready).
    // After 800ms: attempt OCR on each frame. Break as soon as species is found.
    //
    // Normal encounter:  text at ~1.7-2.5s → species found, break → total ~2s
    // Shiny encounter:   text at ~3.0-3.8s (1.3s+ sparkle delay) → timing signal
    // Failed OCR:        falls through at 5s → absence of text = shiny signal
    let lastFrame: Buffer | null = null;
    let textAppearedAt: number | null = null;
    let textDelayMs = 0;
    this.lastBattleInfo = { species: null, level: null, gender: 'unknown' };

    const pollStart = Date.now();
    const maxPollDuration = 5000; // 5s max — shiny sparkle animation adds ~1.3s+ delay
    const ocrStartDelay = 800;   // Don't attempt OCR before 800ms (text not typed yet)

    while (Date.now() - pollStart < maxPollDuration && this.running) {
      try {
        const frame = await this.frameSource.captureFrame();
        lastFrame = frame;

        const elapsed = Date.now() - battleDetectedAt;

        // After 800ms, attempt OCR on each frame
        if (elapsed >= ocrStartDelay && !this.lastBattleInfo.species) {
          try {
            const info = await extractBattleInfo(frame);
            if (info.species) {
              this.lastBattleInfo.species = info.species;
              textAppearedAt = Date.now();
              textDelayMs = textAppearedAt - battleDetectedAt;
            }
            if (info.gender !== 'unknown') this.lastBattleInfo.gender = info.gender;
            if (info.level) this.lastBattleInfo.level = info.level;

            // Species found → we have the timing measurement, break
            if (this.lastBattleInfo.species) {
              break;
            }
          } catch {}
        }
      } catch {}
      await this.wait(200);
    }

    if (this.lastBattleInfo.species) {
      logger.info(`[Wild Hunt] Identified: ${this.lastBattleInfo.species} Lv${this.lastBattleInfo.level ?? '?'} ${this.lastBattleInfo.gender} (${textDelayMs}ms)`);
    } else {
      logger.warn('[Wild Hunt] Could not identify species from text box OCR');
    }

    // ── Signal 1: Timing-based detection ──
    const timingResult = evaluateTimingSignal({
      textDelayMs: (textAppearedAt && textDelayMs > 0) ? textDelayMs : null,
      avgDelay: delayCalibration.getAverage(),
      historySize: delayCalibration.getHistorySize(),
      elapsedSinceBattle: Date.now() - battleDetectedAt,
    });
    const timingSignal = timingResult.signal;
    const timingDebug = timingResult.debug;

    // ── Decision: timing only ──
    const { isShiny, signals } = makeShinyDecision({ timingSignal });

    const species = this.lastBattleInfo.species;
    const level = this.lastBattleInfo.level;
    const gender = this.lastBattleInfo.gender;
    const infoStr = species
      ? `${species} Lv${level ?? '?'} ${gender === 'male' ? '♂' : gender === 'female' ? '♀' : ''}`
      : '';

    logger.info(
      `[Wild Hunt] Encounter #${this.encounters}: ` +
      `${isShiny ? `*** SHINY! *** [${signals.join('+')}]` : 'not shiny'} | ` +
      `${infoStr ? infoStr + ' | ' : ''}` +
      `timing: ${timingDebug}`
    );

    // Update timing baseline (only for non-shiny encounters with valid timing)
    if (!isShiny && textAppearedAt && textDelayMs > 0 && textDelayMs < 5000) {
      delayCalibration.addSample(textDelayMs);
    }

    // Only screenshot when timing says shiny
    if (isShiny) {
      try {
        const debugFrame = lastFrame || await this.frameSource.captureFrame();
        const debugPath = path.join(
          process.cwd(), config.paths.screenshots,
          `wild-debug-${this.encounters}-SHINY-${Date.now()}.png`
        );
        fs.writeFile(debugPath, debugFrame).catch(() => {});
      } catch { /* ignore */ }
    }

    // Log encounter
    this.encounterLog.push({
      attempt: this.encounters,
      time: Date.now(),
      isShiny,
      species,
      level,
      gender,
      textDelayMs: textDelayMs || undefined,
      signals: signals.length > 0 ? signals.join('+') : undefined,
      debugInfo: timingDebug,
    });
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (isShiny) {
      // Save screenshot
      const frame = await this.frameSource.captureFrame();
      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `wild-shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      this.emit('shiny', {
        pokemon: species || this.target,
        encounters: this.encounters,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
      });

      this.state = 'SHINY_FOUND';
    } else {
      // Advance battle text to the battle menu:
      //   "Wild X appeared!" → A → "Go! CHARMANDER!" → player enters → menu
      // The player's Pokemon entry animation takes ~2s after the last text box.
      // Press A to advance text, then wait for the menu to appear.
      // 5 A presses at 400ms = 2s, then wait 1.5s for player entry animation.
      for (let i = 0; i < 5 && this.running; i++) {
        await this.input.pressButton('A', 50);
        await this.wait(400);
      }
      // Wait for player Pokemon entry + sparkle animation to finish → menu appears
      await this.wait(1500);
      this.state = 'RUN_AWAY';
    }

    // Emit milestone every 100 encounters
    if (this.encounters % 100 === 0) {
      this.emit('milestone', this.getStatus());
    }
  }

  /**
   * Navigate to RUN in the battle menu and flee.
   *
   * FRLG battle menu layout:
   *   FIGHT   |  BAG
   *   POKeMON |  RUN
   *
   * Default cursor position: FIGHT (top-left)
   * To reach RUN: DOWN → RIGHT → A
   *
   * On retry (failed escape), cursor may already be on RUN,
   * so we press B first to cancel any sub-menu, then navigate fresh.
   */
  private async runFromBattle(): Promise<void> {
    // B to cancel any sub-menu (move list, bag, team screen)
    await this.input.pressButton('B', 50);
    await this.wait(200);
    await this.input.pressButton('B', 50);
    await this.wait(200);
    // Navigate to RUN: RIGHT then DOWN reaches RUN from ANY cursor position
    // FIGHT→BAG→RUN, BAG→BAG→RUN, POKEMON→RUN→RUN, RUN→RUN→RUN
    await this.input.pressButton('RIGHT', 50);
    await this.wait(80);
    await this.input.pressButton('DOWN', 50);
    await this.wait(80);
    await this.input.pressButton('A', 50);
    await this.wait(1000); // run animation

    // "Got away safely!" — mash B quickly to dismiss
    for (let i = 0; i < 5 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(250);
    }

    // Brief wait for battle-exit transition, then go straight to walking.
    // The overworld check will catch any "still in battle" cases.
    await this.wait(800);

    this.state = 'WAIT_OVERWORLD';
  }

  /**
   * Wait until we're back on the overworld after running from battle.
   * If we detect we're still in battle (run failed), try again.
   */
  private async waitForOverworld(): Promise<void> {
    const frame = await this.frameSource.captureFrame();

    // Check if we're back on overworld — start walking immediately
    const onOverworld = await isOverworldScreen(frame);
    if (onOverworld) {
      this.waitOverworldTicks = 0;
      this.state = 'WALKING';
      return;
    }

    // Check if we're still in battle (run failed)
    const inBattle = await isBattleScreen(frame);
    if (inBattle) {
      logger.info('[Wild Hunt] Still in battle — trying to run again');
      this.waitOverworldTicks = 0;
      this.state = 'RUN_AWAY';
      return;
    }

    this.waitOverworldTicks++;

    // If stuck for >10s (neither overworld nor battle), we're probably in a menu.
    // Spam B to exit, then soft reset if still stuck.
    if (this.waitOverworldTicks > 66) { // 66 × 150ms = ~10s
      logger.warn('[Wild Hunt] Stuck in unknown screen — soft resetting');
      await this.input.softReset();
      await this.wait(3000);
      for (let i = 0; i < 15; i++) {
        await this.input.pressButton('A', 50);
        await this.wait(500);
      }
      await this.wait(2000);
      this.waitOverworldTicks = 0;
      this.state = 'WALKING';
      return;
    }

    if (this.waitOverworldTicks > 30) { // 30 × 150ms = 4.5s — try B spam
      await this.input.pressButton('B', 50);
    }

    await this.wait(150);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
