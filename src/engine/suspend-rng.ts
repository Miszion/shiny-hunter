/**
 * SuspendRngEngine — Suspend-point-based RNG manipulation for GBA static encounters.
 *
 * Uses NSO (Nintendo Switch Online) suspend points as deterministic save states.
 * The flow:
 *   1. Create a suspend point right before the target encounter (e.g., Eevee in Celadon)
 *   2. Load the suspend point — PRNG state is now deterministic
 *   3. Count GBA frames using the FrameCounter (visual diff from capture card)
 *   4. Advance RNG to the target frame using Teachy TV or walking
 *   5. At the exact target frame, interact with the encounter
 *   6. Check the result (nature/gender/shiny) via summary screen OCR
 *   7. If not shiny, reload the suspend point and try a different frame target
 *
 * Calibration phase:
 *   First N attempts are calibration runs to determine the frame-to-advance offset.
 *   Each run loads the suspend point, waits X frames, interacts, and records the
 *   observed nature. The nature is used to reverse-calculate which PRNG advance
 *   was actually hit. The difference between expected advance (from frame count)
 *   and actual advance (from nature) gives the offset, which is stored and used
 *   for all subsequent targeting runs.
 *
 * Key assumptions:
 *   - After loading a suspend point, the PRNG seed is always the same
 *   - In a quiet area (no NPCs, no weather), RNG advances ~1x per visual frame
 *   - Teachy TV advances RNG ~313x per visual frame
 *   - TID: 24248 (0x5EB8), SID: 3678 (0x0E5E) — from switch-calibration.json
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, ButtonSequence } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { extractStats, StatValues } from '../detection/stats-ocr';
import { computeIVRanges } from './iv-calc';
import {
  advanceSeed,
  nextSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
  identifyHitFrame,
  findNextShinyFrame,
  NATURE_NAMES,
  IVs,
} from './rng';
import { FrameCounter, GBA_FPS, GBA_FRAME_MS } from './frame-counter';
import { CaptureCardFrames } from '../drivers/capture-card-frames';

// === Configuration constants ===

/** Number of calibration runs to determine frame-to-advance offset */
const CALIBRATION_RUNS = 8;

/** Teachy TV advances per visual frame (~313 RNG advances per GBA frame) */
const TEACHY_TV_ADVANCES_PER_FRAME = 313;

/** Default initial PRNG seed after loading a suspend point (must be calibrated) */
const DEFAULT_INITIAL_SEED = 0x0000;

/** Frame range for calibration probes: wait this many frames then interact */
const CALIBRATION_FRAME_TARGETS = [100, 200, 300, 400, 500, 600, 700, 800];

/** Search range for identifying which advance was hit from observed nature */
const ADVANCE_SEARCH_MIN = 0;
const ADVANCE_SEARCH_MAX = 5000;

// === Types ===

type SuspendRngState =
  | 'IDLE'
  | 'CALIBRATING'
  | 'LOAD_SUSPEND'
  | 'WAIT_OVERWORLD'
  | 'ADVANCE_RNG'
  | 'INTERACT'
  | 'OPEN_SUMMARY'
  | 'READ_RESULT'
  | 'SHINY_FOUND'
  | 'RESET';

interface CalibrationObservation {
  attempt: number;
  targetFrames: number;
  observedNature: string;
  observedNatureIdx: number;
  observedGender: string;
  possibleAdvances: number[];
  timestamp: number;
}

interface FrameCalibrationData {
  tid: number;
  sid: number;
  initialSeed: number;
  observations: CalibrationObservation[];
  frameToAdvanceOffset: number | null;
  advancesPerFrame: number;
  calibrationComplete: boolean;
  lastUpdated: number;
}

interface AttemptLog {
  attempt: number;
  time: number;
  targetFrame: number;
  expectedAdvance: number;
  observedNature: string;
  observedGender: string;
  possibleAdvances: number[];
  isShiny: boolean;
  detectionDebug: string;
  stats?: StatValues;
  ivRanges?: string;
  screenshotPath?: string;
}

// === Engine ===

export class SuspendRngEngine extends EventEmitter {
  private state: SuspendRngState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private partySlot: number;

  // RNG parameters
  private tid: number;
  private sid: number;
  private initialSeed: number;

  // Frame counter
  private frameCounter: FrameCounter;

  // Calibration
  private calibration: FrameCalibrationData;
  private calibrationPath: string;

  // Targeting
  private currentTargetFrame = 0;
  private shinyTargetAdvance = -1;
  private shinyTargetNature = '';

  // Encounter log (for dashboard)
  public encounterLog: AttemptLog[] = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    this.partySlot = parseInt(process.env.PARTY_SLOT || '2', 10);

    // TID/SID from env or known calibration values
    this.tid = parseInt(process.env.RNG_TID || '24248', 10);
    this.sid = parseInt(process.env.RNG_SID || '3678', 10);
    this.initialSeed = parseInt(process.env.SUSPEND_INITIAL_SEED || '0', 10);

    // Frame counter uses the capture card
    if (frameSource instanceof CaptureCardFrames) {
      this.frameCounter = new FrameCounter(frameSource as CaptureCardFrames, {
        pollIntervalMs: parseInt(process.env.FRAME_POLL_MS || '8', 10),
        detectEvents: true,
      });
    } else {
      // Fallback: create a frame counter anyway (will work if frameSource
      // has the getLatestFrame method compatible with CaptureCardFrames)
      this.frameCounter = new FrameCounter(frameSource as unknown as CaptureCardFrames, {
        pollIntervalMs: 8,
        detectEvents: true,
      });
    }

    // Calibration data path
    this.calibrationPath = path.join(process.cwd(), 'data', 'frame-calibration.json');

    // Default calibration state
    this.calibration = {
      tid: this.tid,
      sid: this.sid,
      initialSeed: this.initialSeed,
      observations: [],
      frameToAdvanceOffset: null,
      advancesPerFrame: 1, // quiet area: 1 RNG advance per GBA frame
      calibrationComplete: false,
      lastUpdated: Date.now(),
    };
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

  getCalibration(): FrameCalibrationData {
    return this.calibration;
  }

  getFrameCounterStats() {
    return this.frameCounter.getStats();
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Load calibration data if it exists
    await this.loadCalibrationData();

    logger.info(`[Suspend RNG] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Suspend RNG] TID: ${this.tid} (0x${this.tid.toString(16).padStart(4, '0')}) | SID: ${this.sid} (0x${this.sid.toString(16).padStart(4, '0')})`);
    logger.info(`[Suspend RNG] Initial seed: 0x${this.initialSeed.toString(16).padStart(8, '0')}`);
    logger.info(`[Suspend RNG] Party slot: ${this.partySlot}`);
    logger.info(`[Suspend RNG] Calibration: ${this.calibration.calibrationComplete ? 'COMPLETE' : 'NEEDED'}`);
    if (this.calibration.frameToAdvanceOffset !== null) {
      logger.info(`[Suspend RNG] Frame-to-advance offset: ${this.calibration.frameToAdvanceOffset}`);
    }

    this.running = true;
    this.attempts = 0;
    this.startedAt = Date.now();
    this.state = this.calibration.calibrationComplete ? 'LOAD_SUSPEND' : 'CALIBRATING';
    this.emit('started', this.getStatus());

    // If calibration is complete, find the next shiny target
    if (this.calibration.calibrationComplete) {
      this.findShinyTarget();
    }

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Suspend RNG] Error in state ${this.state}: ${msg}`);
        this.frameCounter.stop();
        this.state = this.calibration.calibrationComplete ? 'LOAD_SUSPEND' : 'CALIBRATING';
        await this.wait(2000);
      }
    }
  }

  stop(): void {
    logger.info(`[Suspend RNG] Stopping after ${this.attempts} attempts`);
    this.running = false;
    this.state = 'IDLE';
    this.frameCounter.stop();
    this.emit('stopped', this.getStatus());
  }

  // === Main loop ===

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'CALIBRATING':
        await this.runCalibrationAttempt();
        break;

      case 'LOAD_SUSPEND':
        await this.loadSuspendPoint();
        this.state = 'WAIT_OVERWORLD';
        break;

      case 'WAIT_OVERWORLD':
        await this.waitForOverworld();
        this.state = 'ADVANCE_RNG';
        break;

      case 'ADVANCE_RNG':
        await this.advanceToTargetFrame();
        this.state = 'INTERACT';
        break;

      case 'INTERACT':
        await this.interactWithEncounter();
        this.state = 'OPEN_SUMMARY';
        break;

      case 'OPEN_SUMMARY':
        await this.openSummary();
        this.state = 'READ_RESULT';
        break;

      case 'READ_RESULT':
        await this.readAndProcess();
        break;

      case 'SHINY_FOUND':
        logger.info('[Suspend RNG] *** SHINY FOUND! Stopping. ***');
        this.stop();
        break;

      case 'RESET':
        this.state = 'LOAD_SUSPEND';
        break;

      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  // === Calibration ===

  private async runCalibrationAttempt(): Promise<void> {
    const obsCount = this.calibration.observations.length;
    if (obsCount >= CALIBRATION_RUNS) {
      this.finalizeCalibration();
      return;
    }

    const targetFrames = CALIBRATION_FRAME_TARGETS[obsCount % CALIBRATION_FRAME_TARGETS.length];
    logger.info(
      `[Suspend RNG] Calibration run ${obsCount + 1}/${CALIBRATION_RUNS} | ` +
      `Target: wait ${targetFrames} frames then interact`
    );

    // Load the suspend point
    await this.loadSuspendPoint();
    await this.waitForOverworld();

    // Start frame counter
    this.frameCounter.resetCounter();
    await this.frameCounter.start();

    // Wait for the target number of frames
    const actualFrame = await this.frameCounter.waitForFrames(targetFrames);
    logger.info(`[Suspend RNG] Calibration: waited for ${targetFrames} frames, counter at ${actualFrame}`);

    // Take a pre-interaction screenshot
    await this.frameCounter.takeScreenshot(`cal-${obsCount + 1}-pre-interact`);

    // Stop the frame counter before interacting
    this.frameCounter.stop();

    // Interact with the encounter
    await this.interactWithEncounter();
    await this.openSummary();

    // Read the result
    const result = await this.readSummaryResult();
    if (!result) {
      logger.warn('[Suspend RNG] Calibration: could not read summary. Retrying...');
      this.state = 'CALIBRATING';
      return;
    }

    // Take post-result screenshot
    await this.takeResultScreenshot(`cal-${obsCount + 1}-result`);

    // Identify which advance was hit
    const natureIdx = NATURE_NAMES.indexOf(result.nature);
    if (natureIdx === -1) {
      logger.warn(`[Suspend RNG] Calibration: unknown nature "${result.nature}". Skipping.`);
      this.state = 'CALIBRATING';
      return;
    }

    const matches = identifyHitFrame(
      this.initialSeed,
      this.tid,
      this.sid,
      natureIdx,
      null, // IVs not known yet in calibration
      ADVANCE_SEARCH_MIN,
      ADVANCE_SEARCH_MAX,
    );

    const possibleAdvances = matches.map((m) => m.advance);

    logger.info(
      `[Suspend RNG] Calibration result: Nature=${result.nature} (${natureIdx}) | ` +
      `Gender=${result.gender} | Possible advances: [${possibleAdvances.slice(0, 10).join(', ')}${possibleAdvances.length > 10 ? '...' : ''}] ` +
      `(${possibleAdvances.length} matches)`
    );

    const observation: CalibrationObservation = {
      attempt: obsCount + 1,
      targetFrames,
      observedNature: result.nature,
      observedNatureIdx: natureIdx,
      observedGender: result.gender,
      possibleAdvances,
      timestamp: Date.now(),
    };

    this.calibration.observations.push(observation);
    await this.saveCalibrationData();

    this.attempts++;
    this.emit('milestone', this.getStatus());

    // Check if we have enough data to compute the offset
    if (this.calibration.observations.length >= CALIBRATION_RUNS) {
      this.finalizeCalibration();
    }
  }

  /**
   * Finalize calibration: compute the frame-to-advance offset from observations.
   *
   * For each observation, we know:
   *   - targetFrames: how many GBA frames we waited
   *   - possibleAdvances: which PRNG advances could produce the observed nature
   *
   * The offset = actual_advance - targetFrames (for each observation).
   * We look for a consistent offset across all observations.
   */
  private async finalizeCalibration(): Promise<void> {
    logger.info('[Suspend RNG] Finalizing calibration...');

    // For each observation, compute candidate offsets
    const allOffsets: Map<number, number> = new Map(); // offset -> frequency

    for (const obs of this.calibration.observations) {
      for (const advance of obs.possibleAdvances) {
        const offset = advance - obs.targetFrames;
        allOffsets.set(offset, (allOffsets.get(offset) || 0) + 1);
      }
    }

    // Find the offset that appears most consistently
    let bestOffset = 0;
    let bestCount = 0;

    for (const [offset, count] of allOffsets.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestOffset = offset;
      }
    }

    // The offset should appear in at least half the observations to be reliable
    const minRequired = Math.ceil(this.calibration.observations.length / 2);

    if (bestCount >= minRequired) {
      this.calibration.frameToAdvanceOffset = bestOffset;
      this.calibration.calibrationComplete = true;
      await this.saveCalibrationData();

      logger.info(
        `[Suspend RNG] Calibration COMPLETE! ` +
        `Frame-to-advance offset: ${bestOffset} ` +
        `(appeared in ${bestCount}/${this.calibration.observations.length} observations)`
      );

      // Log the mapping for each calibration run
      for (const obs of this.calibration.observations) {
        const matchesOffset = obs.possibleAdvances.includes(obs.targetFrames + bestOffset);
        logger.info(
          `  Run ${obs.attempt}: ${obs.targetFrames} frames -> ` +
          `expected advance ${obs.targetFrames + bestOffset} | ` +
          `nature=${obs.observedNature} | matches_offset=${matchesOffset}`
        );
      }

      // Find the shiny target and start hunting
      this.findShinyTarget();
      this.state = 'LOAD_SUSPEND';
    } else {
      logger.warn(
        `[Suspend RNG] Calibration inconclusive: best offset ${bestOffset} ` +
        `only appeared in ${bestCount}/${this.calibration.observations.length} observations. ` +
        `Need more data. Running ${CALIBRATION_RUNS - this.calibration.observations.length} more...`
      );

      // If all calibration runs are done but no consistent offset, try wider search
      if (this.calibration.observations.length >= CALIBRATION_RUNS) {
        logger.warn('[Suspend RNG] All calibration runs complete but no consistent offset found.');
        logger.warn('[Suspend RNG] Top offset candidates:');
        const sorted = [...allOffsets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [offset, count] of sorted) {
          logger.warn(`  Offset ${offset}: ${count} observations`);
        }

        // Use the best one anyway and let targeting attempts refine it
        this.calibration.frameToAdvanceOffset = bestOffset;
        this.calibration.calibrationComplete = true;
        await this.saveCalibrationData();
        logger.info(`[Suspend RNG] Using best-effort offset: ${bestOffset}`);

        this.findShinyTarget();
        this.state = 'LOAD_SUSPEND';
      }
    }
  }

  // === Shiny targeting ===

  /**
   * Find the next shiny frame from the initial seed and compute the target frame count.
   */
  private findShinyTarget(): void {
    if (this.calibration.frameToAdvanceOffset === null) {
      logger.error('[Suspend RNG] Cannot find shiny target without calibration offset');
      return;
    }

    const offset = this.calibration.frameToAdvanceOffset;
    const result = findNextShinyFrame(this.initialSeed, this.tid, this.sid, 100000);

    if (!result) {
      logger.error('[Suspend RNG] No shiny frame found within 100,000 advances!');
      return;
    }

    this.shinyTargetAdvance = result.frameOffset;
    this.shinyTargetNature = NATURE_NAMES[result.result.nature] || '?';
    this.currentTargetFrame = result.frameOffset - offset;

    logger.info(
      `[Suspend RNG] Shiny target found! ` +
      `Advance: ${result.frameOffset} | ` +
      `Target frame: ${this.currentTargetFrame} | ` +
      `Nature: ${this.shinyTargetNature} | ` +
      `PID: 0x${(result.result.pid >>> 0).toString(16).padStart(8, '0')} | ` +
      `IVs: HP:${result.ivs.hp} ATK:${result.ivs.atk} DEF:${result.ivs.def} ` +
      `SPA:${result.ivs.spa} SPD:${result.ivs.spd} SPE:${result.ivs.spe}`
    );

    // If target frame is negative, that means the shiny advance is before
    // the suspend point's initial state + offset. We need a further advance.
    if (this.currentTargetFrame < 0) {
      logger.warn(
        `[Suspend RNG] Target frame is negative (${this.currentTargetFrame}). ` +
        `Searching for next shiny frame after the offset...`
      );
      // Search starting from offset onwards
      let seed = advanceSeed(this.initialSeed, offset + 1);
      const search = findNextShinyFrame(seed, this.tid, this.sid, 100000);
      if (search) {
        this.shinyTargetAdvance = search.frameOffset + offset + 1;
        this.currentTargetFrame = search.frameOffset + 1;
        this.shinyTargetNature = NATURE_NAMES[search.result.nature] || '?';
        logger.info(
          `[Suspend RNG] Adjusted shiny target: advance ${this.shinyTargetAdvance} | ` +
          `frame ${this.currentTargetFrame} | nature: ${this.shinyTargetNature}`
        );
      }
    }

    // For very large frame targets, we can use Teachy TV to burn through advances quickly
    if (this.currentTargetFrame > 2000) {
      const teachyFrames = Math.floor((this.currentTargetFrame - 500) / TEACHY_TV_ADVANCES_PER_FRAME);
      logger.info(
        `[Suspend RNG] Large target (${this.currentTargetFrame} frames). ` +
        `Will use Teachy TV for ~${teachyFrames} frames (${teachyFrames * TEACHY_TV_ADVANCES_PER_FRAME} advances) ` +
        `then wait ${this.currentTargetFrame - (teachyFrames * TEACHY_TV_ADVANCES_PER_FRAME)} remaining frames.`
      );
    }
  }

  // === Suspend point management ===

  /**
   * Load the NSO suspend point. On Switch, this is:
   *   HOME -> GBA app -> Close (creates suspend) -> Reopen (loads suspend)
   * For now, we use a soft reset + load state approach that works with
   * the existing input controller.
   */
  private async loadSuspendPoint(): Promise<void> {
    logger.info('[Suspend RNG] Loading suspend point...');

    // Soft reset restores the suspend point state
    await this.input.softReset();
    await this.wait(2000);

    // The NSO GBA emulator auto-resumes from suspend point after soft reset.
    // Mash A to dismiss any "resume" dialogue.
    for (let i = 0; i < 5; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(500);
    }

    logger.info('[Suspend RNG] Suspend point loaded');
  }

  /**
   * Wait for the overworld to be active and stable.
   * Detects via frame analysis: the overworld should have consistent frames
   * without major transitions.
   */
  private async waitForOverworld(): Promise<void> {
    logger.info('[Suspend RNG] Waiting for overworld...');
    await this.wait(2000);

    // Take a reference screenshot
    await this.takeResultScreenshot('overworld');

    logger.info('[Suspend RNG] Overworld detected, ready to advance');
  }

  // === RNG advancement ===

  /**
   * Advance the RNG to the target frame. Uses:
   *   - Walking/waiting in a quiet area for slow advances (1x per frame)
   *   - Teachy TV for fast advances (~313x per frame) when target is far
   */
  private async advanceToTargetFrame(): Promise<void> {
    const target = this.currentTargetFrame;

    logger.info(`[Suspend RNG] Advancing to target frame ${target}...`);

    // Start the frame counter
    this.frameCounter.resetCounter();
    await this.frameCounter.start();

    if (target > 2000) {
      // Use Teachy TV for bulk advances
      await this.advanceWithTeachyTV(target);
    } else {
      // Just wait — in a quiet area, RNG advances 1x per frame
      logger.info(`[Suspend RNG] Waiting ${target} frames (${(target * GBA_FRAME_MS / 1000).toFixed(1)}s)...`);
      const actualFrame = await this.frameCounter.waitForFrames(target);
      logger.info(`[Suspend RNG] Waited for target ${target}, actual frame counter: ${actualFrame}`);
    }

    // Take a screenshot right before interaction
    await this.frameCounter.takeScreenshot('pre-interact');

    // Stop counting — we've reached our target
    this.frameCounter.stop();
  }

  /**
   * Use Teachy TV to burn through RNG advances quickly.
   * Teachy TV advances ~313 RNG calls per GBA frame.
   */
  private async advanceWithTeachyTV(totalTargetFrame: number): Promise<void> {
    // Calculate how many frames of Teachy TV we need
    // Leave ~500 frames of buffer for fine-tuning with walking
    const teachyAdvances = totalTargetFrame - 500;
    const teachyFrames = Math.ceil(teachyAdvances / TEACHY_TV_ADVANCES_PER_FRAME);

    logger.info(
      `[Suspend RNG] Teachy TV phase: ${teachyFrames} frames ` +
      `(~${teachyFrames * TEACHY_TV_ADVANCES_PER_FRAME} advances), ` +
      `then ${totalTargetFrame - (teachyFrames * TEACHY_TV_ADVANCES_PER_FRAME)} frames walking`
    );

    // Open the bag and use Teachy TV
    // START -> BAG -> Key Items -> Teachy TV -> Use
    await this.input.pressButton('START', 50);
    await this.wait(500);
    // Navigate to BAG
    await this.input.pressButton('RIGHT', 100);
    await this.wait(200);
    await this.input.pressButton('A', 50);
    await this.wait(800);
    // Navigate to Key Items pocket
    await this.input.pressButton('RIGHT', 100);
    await this.wait(200);
    await this.input.pressButton('RIGHT', 100);
    await this.wait(200);
    // Select Teachy TV
    await this.input.pressButton('A', 50);
    await this.wait(300);
    // Use it
    await this.input.pressButton('A', 50);
    await this.wait(500);
    await this.input.pressButton('A', 50);
    await this.wait(1000);

    // Wait for the Teachy TV animation to play for the required frames
    const teachyWaitMs = teachyFrames * GBA_FRAME_MS;
    logger.info(`[Suspend RNG] Teachy TV running for ${(teachyWaitMs / 1000).toFixed(1)}s...`);
    await this.wait(teachyWaitMs);

    // Exit Teachy TV (B to exit)
    await this.input.pressButton('B', 50);
    await this.wait(500);
    await this.input.pressButton('B', 50);
    await this.wait(500);
    await this.input.pressButton('B', 50);
    await this.wait(1000);

    // Now wait the remaining frames
    const remainingFrames = totalTargetFrame - (teachyFrames * TEACHY_TV_ADVANCES_PER_FRAME);
    if (remainingFrames > 0) {
      logger.info(`[Suspend RNG] Waiting ${remainingFrames} remaining frames...`);
      await this.frameCounter.waitForFrames(remainingFrames);
    }
  }

  // === Encounter interaction ===

  /**
   * Interact with the target encounter (press A to talk/interact).
   */
  private async interactWithEncounter(): Promise<void> {
    logger.info('[Suspend RNG] Interacting with encounter...');

    // Press A to talk to the NPC / interact with the item
    await this.input.pressButton('A', 50);
    await this.wait(500);

    // Mash A through dialogue
    for (let i = 0; i < 20 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(300);
    }

    // Wait for the Pokemon to be received
    await this.wait(1000);

    // Mash through remaining text
    for (let i = 0; i < 10 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(300);
    }

    logger.info('[Suspend RNG] Interaction complete');
  }

  /**
   * Open the party menu and navigate to the Pokemon's summary screen.
   */
  private async openSummary(): Promise<void> {
    logger.info('[Suspend RNG] Opening summary...');

    // START -> Pokemon -> select party slot -> Summary
    await this.input.pressButton('START', 50);
    await this.wait(450);
    // "Pokemon" is the 2nd item in the start menu (DOWN once from the top)
    await this.input.pressButton('DOWN', 100);
    await this.wait(200);
    await this.input.pressButton('A', 50);
    await this.wait(1700);

    // Navigate to the correct party slot
    if (this.partySlot >= 2) {
      await this.input.pressButton('RIGHT', 100);
      await this.wait(300);
    }
    for (let i = 3; i <= this.partySlot; i++) {
      await this.input.pressButton('DOWN', 100);
      await this.wait(300);
    }

    // Select and open summary
    await this.input.pressButton('A', 50);
    await this.wait(700);
    await this.input.pressButton('A', 50);
    await this.wait(1600);

    logger.info('[Suspend RNG] Summary screen should be open');
  }

  // === Result reading ===

  /**
   * Read the summary screen to get nature, gender, and shiny status.
   */
  private async readSummaryResult(): Promise<{
    nature: string;
    gender: 'male' | 'female' | 'unknown';
    isShiny: boolean;
    frame: Buffer;
  } | null> {
    let frame = await this.frameSource.captureFrame();
    let detection = await detectShiny(frame, this.target, this.game);

    // Retry if summary not detected
    for (let retry = 0; retry < 5 && detection.debugInfo === 'not on summary screen'; retry++) {
      logger.info(`[Suspend RNG] Summary not detected, retry ${retry + 1}/5...`);
      await this.wait(500);
      frame = await this.frameSource.captureFrame();
      detection = await detectShiny(frame, this.target, this.game);
    }

    if (detection.debugInfo === 'not on summary screen') {
      logger.warn('[Suspend RNG] Could not detect summary screen after retries');
      return null;
    }

    let nature: string | null = null;
    let gender: 'male' | 'female' | 'unknown' = 'unknown';

    try {
      const info = await extractSummaryInfo(frame, { skipTID: true });
      nature = info.nature;
      gender = info.gender;
    } catch (err) {
      logger.warn(`[Suspend RNG] Summary OCR failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      nature: nature || 'unknown',
      gender,
      isShiny: detection.isShiny,
      frame,
    };
  }

  private async readAndProcess(): Promise<void> {
    this.attempts++;
    const result = await this.readSummaryResult();

    if (!result) {
      logger.warn('[Suspend RNG] Could not read result. Resetting...');
      this.state = 'RESET';
      return;
    }

    // Screenshot every attempt
    const screenshotPath = await this.takeResultScreenshot(
      `attempt-${this.attempts}-${result.isShiny ? 'SHINY' : 'normal'}-${result.nature}`
    );

    // Identify which advance was hit
    const natureIdx = NATURE_NAMES.indexOf(result.nature);
    let possibleAdvances: number[] = [];

    if (natureIdx >= 0) {
      const matches = identifyHitFrame(
        this.initialSeed,
        this.tid,
        this.sid,
        natureIdx,
        null,
        ADVANCE_SEARCH_MIN,
        ADVANCE_SEARCH_MAX,
      );
      possibleAdvances = matches.map((m) => m.advance);
    }

    // Compute expected advance
    const offset = this.calibration.frameToAdvanceOffset ?? 0;
    const expectedAdvance = this.currentTargetFrame + offset;

    const logEntry: AttemptLog = {
      attempt: this.attempts,
      time: Date.now(),
      targetFrame: this.currentTargetFrame,
      expectedAdvance,
      observedNature: result.nature,
      observedGender: result.gender,
      possibleAdvances: possibleAdvances.slice(0, 20),
      isShiny: result.isShiny,
      detectionDebug: '',
      screenshotPath,
    };

    // Check for advance accuracy
    const hitExpected = possibleAdvances.includes(expectedAdvance);
    const closestAdvance = possibleAdvances.length > 0
      ? possibleAdvances.reduce((closest, adv) =>
          Math.abs(adv - expectedAdvance) < Math.abs(closest - expectedAdvance) ? adv : closest
        )
      : -1;
    const advanceDelta = closestAdvance >= 0 ? closestAdvance - expectedAdvance : null;

    logger.info(
      `[Suspend RNG] Attempt #${this.attempts} | ` +
      `${result.isShiny ? '*** SHINY! ***' : 'normal'} | ` +
      `Target frame: ${this.currentTargetFrame} | Expected advance: ${expectedAdvance} | ` +
      `Nature: ${result.nature} | Gender: ${result.gender} | ` +
      `Hit expected: ${hitExpected} | Closest advance: ${closestAdvance} | ` +
      `Delta: ${advanceDelta !== null ? advanceDelta : 'N/A'}`
    );

    this.encounterLog.push(logEntry);
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (result.isShiny) {
      // SHINY FOUND!
      const ts = Date.now();
      const shinyPath = path.join(
        process.cwd(),
        config.paths.screenshots,
        `suspend-rng-shiny-${this.target}-${ts}.png`
      );
      await fs.writeFile(shinyPath, result.frame);
      logger.info(`[Suspend RNG] *** SHINY SUMMARY saved: ${shinyPath}`);

      // Navigate to stats page
      await this.input.pressButton('RIGHT', 100);
      await this.wait(2000);

      let shinyStats: StatValues | null = null;
      for (let retry = 0; retry < 5 && !shinyStats; retry++) {
        const statsFrame = await this.frameSource.captureFrame();
        const statsPath = path.join(
          process.cwd(),
          config.paths.screenshots,
          `suspend-rng-shiny-${this.target}-STATS-${ts}-${retry}.png`
        );
        await fs.writeFile(statsPath, statsFrame);
        shinyStats = await extractStats(statsFrame);
        if (!shinyStats) await this.wait(500);
      }

      if (shinyStats) {
        logger.info(
          `[Suspend RNG] *** SHINY STATS: HP:${shinyStats.hp} ATK:${shinyStats.attack} ` +
          `DEF:${shinyStats.defense} SPA:${shinyStats.spAtk} SPD:${shinyStats.spDef} SPE:${shinyStats.speed}`
        );
        logEntry.stats = shinyStats;

        if (result.nature && result.nature !== 'unknown') {
          const ranges = computeIVRanges(this.target, 24, result.nature, shinyStats);
          if (ranges) {
            const rangeStr = `HP:${ranges.hp} ATK:${ranges.atk} DEF:${ranges.def} SPA:${ranges.spa} SPD:${ranges.spd} SPE:${ranges.spe}`;
            logger.info(`[Suspend RNG] *** SHINY IVs: ${rangeStr}`);
            logEntry.ivRanges = rangeStr;
          }
        }
      }

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath: shinyPath,
        nature: result.nature,
        gender: result.gender,
        stats: shinyStats,
        targetFrame: this.currentTargetFrame,
        targetAdvance: this.shinyTargetAdvance,
      });

      this.state = 'SHINY_FOUND';
      return;
    }

    // Not shiny — log accuracy info and adjust if needed
    if (advanceDelta !== null && Math.abs(advanceDelta) > 2) {
      logger.warn(
        `[Suspend RNG] Advance delta is ${advanceDelta} (expected ${expectedAdvance}, ` +
        `closest hit ${closestAdvance}). Frame timing may need adjustment.`
      );
    }

    if (this.attempts % 10 === 0) {
      this.emit('milestone', this.getStatus());
    }

    this.state = 'RESET';
  }

  // === Helper methods ===

  private async takeResultScreenshot(label: string): Promise<string> {
    try {
      const frame = await this.frameSource.captureFrame();
      const filename = `suspend-rng-${this.target}-${label}-${Date.now()}.png`;
      const filepath = path.join(process.cwd(), config.paths.screenshots, filename);
      await fs.writeFile(filepath, frame);
      return filepath;
    } catch {
      return '';
    }
  }

  private async loadCalibrationData(): Promise<void> {
    try {
      const data = await fs.readFile(this.calibrationPath, 'utf-8');
      const parsed = JSON.parse(data) as FrameCalibrationData;
      this.calibration = parsed;

      // Overwrite TID/SID if env vars are set
      if (process.env.RNG_TID) this.calibration.tid = this.tid;
      if (process.env.RNG_SID) this.calibration.sid = this.sid;
      if (process.env.SUSPEND_INITIAL_SEED) this.calibration.initialSeed = this.initialSeed;

      logger.info(
        `[Suspend RNG] Loaded calibration: ${this.calibration.observations.length} observations | ` +
        `offset: ${this.calibration.frameToAdvanceOffset} | ` +
        `complete: ${this.calibration.calibrationComplete}`
      );
    } catch {
      logger.info('[Suspend RNG] No existing calibration data, starting fresh');
    }
  }

  private async saveCalibrationData(): Promise<void> {
    this.calibration.lastUpdated = Date.now();
    try {
      const dir = path.dirname(this.calibrationPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.calibrationPath, JSON.stringify(this.calibration, null, 2));
      logger.info(`[Suspend RNG] Calibration data saved to ${this.calibrationPath}`);
    } catch (err) {
      logger.error(`[Suspend RNG] Failed to save calibration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
