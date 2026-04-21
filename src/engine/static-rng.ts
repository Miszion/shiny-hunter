/**
 * StaticRngEngine — RNG boot timing for static encounters.
 *
 * Combines SwitchRngEngine's precise boot timing with StaticHuntEngine's
 * NPC interaction sequences. Instead of doing the full 40-second interaction
 * on every reset, it checks the PRNG seed from boot timing first. If no
 * advance frame in the configured window can produce a shiny PID, it resets
 * immediately (~5 seconds per attempt instead of ~40 seconds).
 *
 * Flow:
 *   1. Soft reset → record boot timestamp
 *   2. Wait for BIOS + Game Freak logo
 *   3. Timed A press on title screen (determines Timer1 seed)
 *   4. Compute seed from boot timing
 *   5. Check advance window for shiny PID (TID/SID known from calibration)
 *   6. If no shiny possible → reset immediately (skip interaction)
 *   7. If shiny possible → load save → interact with NPC → open summary → verify
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
import { getStaticSequences } from './sequences';
import { FrameCounter } from './frame-counter';
import { CaptureCardFrames } from '../drivers/capture-card-frames';
import {
  advanceSeed,
  nextSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
  NATURE_NAMES,
  IVs,
} from './rng';
import {
  bootTimingToSeed,
  seedToBootTimingMs,
} from './seed-table';
import {
  CalibrationState,
  loadCalibration,
} from './calibration';

type StaticRngState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TIMED_TITLE_PRESS'
  | 'SEED_CHECK'
  | 'LOAD_SAVE'
  | 'INTERACT'
  | 'OPEN_SUMMARY'
  | 'READ_RESULT'
  | 'SHINY_FOUND'
  | 'RESET';

export class StaticRngEngine extends EventEmitter {
  private state: StaticRngState = 'IDLE';
  private attempts = 0;
  private skippedSeeds = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private partySlot: number;

  // Calibration / RNG state
  private cal: CalibrationState | null = null;
  private tid: number;
  private sid: number;
  private advanceMin: number;
  private advanceMax: number;
  private biosOffsetMs: number;

  // Boot timing
  private bootTimestamp = 0;
  private aPressTimestamp = 0;
  private lastHitSeed = 0;
  private lastShinyAdvance = -1;
  private lastShinyNature = '';

  // Week-1 frame-counting spike instrumentation. Off unless RNG_INSTRUMENT=true.
  // When on, records per-attempt GBA frame counts at every button press and
  // every visual event so we can measure the real variance of the dialog
  // sequence and decide whether frame-synced inputs are worth the engineering.
  private fc: FrameCounter | null = null;
  private instrumentLog: Array<{ t: number; frame: number; label: string }> = [];

  private logFC(label: string): void {
    if (!this.fc) return;
    const frame = this.fc.getFrameCount();
    const t = Date.now();
    this.instrumentLog.push({ t, frame, label });
    logger.info(`[FC] f=${frame} t+${t - this.bootTimestamp}ms ${label}`);
  }

  public encounterLog: Array<{
    attempt: number;
    time: number;
    nature: string;
    gender: string;
    isShiny: boolean;
    detectionDebug: string;
    stats?: StatValues;
    ivRanges?: string;
    seed: string;
    shinyAdvance: number;
  }> = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    this.partySlot = parseInt(process.env.PARTY_SLOT || '2', 10);

    // Use calibration data if available, fall back to config/env
    this.tid = parseInt(process.env.RNG_TID || '24248', 10);
    this.sid = parseInt(process.env.RNG_SID || '3678', 10);
    this.advanceMin = parseInt(process.env.RNG_ADVANCE_MIN || '1050', 10);
    this.advanceMax = parseInt(process.env.RNG_ADVANCE_MAX || '1250', 10);
    this.biosOffsetMs = config.rng.biosOffsetMs;
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

    // Load calibration data to get TID, SID, advance window, biosOffset
    try {
      this.cal = await loadCalibration();
      if (this.cal.tid !== null) this.tid = this.cal.tid;
      if (this.cal.sid !== null) this.sid = this.cal.sid;
      this.advanceMin = this.cal.advanceWindow.min;
      this.advanceMax = this.cal.advanceWindow.max;
      this.biosOffsetMs = this.cal.biosOffsetMs;
    } catch {
      logger.warn('[Static RNG] Could not load calibration — using env/defaults');
    }

    logger.info(`[Static RNG] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Static RNG] TID: ${this.tid} | SID: ${this.sid}`);
    logger.info(`[Static RNG] Advance window: [${this.advanceMin}, ${this.advanceMax}]`);
    logger.info(`[Static RNG] BIOS offset: ${this.biosOffsetMs}ms`);
    logger.info(`[Static RNG] Party slot: ${this.partySlot}`);

    // Instrumentation: wire up FrameCounter if RNG_INSTRUMENT=true and we're
    // running against real capture-card hardware.
    if (process.env.RNG_INSTRUMENT === 'true' && this.frameSource instanceof CaptureCardFrames) {
      this.fc = new FrameCounter(this.frameSource as CaptureCardFrames, { pollIntervalMs: 16 });
      this.fc.on('transition', (e) => this.logFC(`event:transition diff=${e.diffPercent.toFixed(1)}%`));
      this.fc.on('text_appeared', (e) => this.logFC('event:text_appeared'));
      this.fc.on('text_cleared', (e) => this.logFC('event:text_cleared'));
      this.fc.on('fade_to_black', (e) => this.logFC('event:fade_to_black'));
      this.fc.on('fade_from_black', (e) => this.logFC('event:fade_from_black'));
      await this.fc.start();
      logger.info('[Static RNG] Instrumentation ON — FrameCounter attached');
    }

    this.running = true;
    this.attempts = 0;
    this.skippedSeeds = 0;
    this.startedAt = Date.now();
    this.state = 'SOFT_RESET';
    this.emit('started', this.getStatus());

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Static RNG] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[Static RNG] Stopping after ${this.attempts} attempts (${this.skippedSeeds} seeds skipped)`);
    if (this.fc) {
      this.fc.stop();
      this.fc = null;
    }
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'SOFT_RESET':
        await this.input.softReset();
        this.bootTimestamp = Date.now();
        this.instrumentLog = []; // reset per-attempt log on each soft-reset
        if (this.fc) this.fc.resetCounter();
        this.logFC('state:SOFT_RESET');
        this.state = 'WAIT_BOOT';
        break;

      case 'WAIT_BOOT':
        // Wait for BIOS + intro logos. Do NOT press A — it would bypass the
        // timed press and give a random seed. 6000ms is the empirically-
        // calibrated minimum on this platform — 5000ms tested too short
        // (title menu not ready, A press lost).
        await this.wait(config.env === 'switch' ? 6000 : 4500);
        this.logFC('state:WAIT_BOOT done');
        this.state = 'TIMED_TITLE_PRESS';
        break;

      case 'TIMED_TITLE_PRESS':
        await this.timedTitlePress();
        this.logFC('state:TIMED_TITLE_PRESS done (A pressed on title)');
        this.state = 'SEED_CHECK';
        break;

      case 'SEED_CHECK':
        await this.checkSeedForShiny();
        break;

      case 'LOAD_SAVE':
        this.logFC('state:LOAD_SAVE start');
        await this.loadSaveAndNavigate();
        this.logFC('state:LOAD_SAVE done (save loaded, ready to interact)');
        this.state = 'INTERACT';
        break;

      case 'INTERACT':
        this.logFC('state:INTERACT start');
        await this.interactWithNPC();
        this.logFC('state:INTERACT done');
        this.state = 'OPEN_SUMMARY';
        break;

      case 'OPEN_SUMMARY':
        this.logFC('state:OPEN_SUMMARY start');
        await this.openSummary();
        this.logFC('state:OPEN_SUMMARY done');
        this.state = 'READ_RESULT';
        break;

      case 'READ_RESULT':
        await this.readAndProcess();
        this.logFC(`state:READ_RESULT done (attempt #${this.attempts})`);
        // Per-attempt instrumentation summary — one line of JSON for later analysis.
        if (this.fc && this.instrumentLog.length > 0) {
          const trace = this.instrumentLog.map((e) => ({
            dt: e.t - this.bootTimestamp, f: e.frame, l: e.label,
          }));
          logger.info(`[FC-TRACE] attempt=${this.attempts} ${JSON.stringify(trace)}`);
        }
        break;

      case 'SHINY_FOUND':
        logger.info('[Static RNG] *** SHINY FOUND! ***');
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

  /**
   * Press A at the title screen with precision timing.
   * The exact moment determines the Timer1 value = initial PRNG seed.
   * We cycle through all 65536 possible seeds systematically.
   */
  private async timedTitlePress(): Promise<void> {
    // Cycle through seeds systematically. Each seed corresponds to a
    // specific boot timing. We step through them to cover the full range.
    // The seed space is 0x0000-0xFFFF (65536 seeds).
    //
    // Strategy: vary the timing on each attempt. We use the attempt counter
    // to offset from a base timing, covering new seeds each iteration.
    // The step size (~61 microseconds per seed at 16384 Hz) means we sweep
    // through seeds one at a time by adding ~0.061ms per attempt.

    // Offset from the minimum reachable seed — seeds below that correspond
    // to A-press times before the emulator is ready, which clamp to the
    // min press time and collapse onto the same seed every attempt.
    // With WAIT_BOOT=6000ms and biosOffsetMs=4500, the earliest reachable
    // seed is ~0x6000.
    const MIN_PRESS_MS_BUFFER = 6010; // 10ms slop above WAIT_BOOT end
    const minReachableSeed = Math.floor(
      ((MIN_PRESS_MS_BUFFER - this.biosOffsetMs) * 16384) / 1000,
    ) & 0xffff;
    const reachableRange = (0x10000 - minReachableSeed) & 0xffff;
    const targetSeed = (minReachableSeed + (this.attempts % reachableRange)) & 0xffff;
    const targetTimingMs = seedToBootTimingMs(targetSeed, this.biosOffsetMs);

    // Wait until the target timing relative to boot
    const elapsed = Date.now() - this.bootTimestamp;
    const remaining = targetTimingMs - elapsed;

    if (remaining > 0) {
      // Use setTimeout for the bulk of the wait, then busy-wait for precision
      if (remaining > 100) {
        await this.wait(remaining - 50);
      }
      // Busy-wait for sub-ms accuracy
      const targetTime = this.bootTimestamp + targetTimingMs;
      while (Date.now() < targetTime) {
        // spin
      }
    }

    // Press A exactly now
    this.aPressTimestamp = Date.now();
    await this.input.pressButton('A', 50);
    await this.wait(200);
    // Second A to dismiss any remaining title elements
    await this.input.pressButton('A', 50);
    await this.wait(500);
  }

  /**
   * Check if the seed hit from boot timing can produce a shiny in
   * the advance window. If not, skip the interaction and reset.
   */
  private async checkSeedForShiny(): Promise<void> {
    this.attempts++;

    // Estimate the seed from the actual A press timing
    const aPressMs = this.aPressTimestamp - this.bootTimestamp;
    const estimatedSeed = bootTimingToSeed(aPressMs, this.biosOffsetMs);

    // Check a small window of seeds around the estimate to account for
    // timing jitter (±3 seeds covers ±~0.18ms of uncertainty)
    const SEED_TOLERANCE = 3;
    const seedMin = Math.max(0, estimatedSeed - SEED_TOLERANCE);
    const seedMax = Math.min(0xFFFF, estimatedSeed + SEED_TOLERANCE);

    let foundShiny = false;
    let shinySeed = 0;
    let shinyAdvance = -1;
    let shinyNature = '';

    for (let initSeed = seedMin; initSeed <= seedMax && !foundShiny; initSeed++) {
      let seed = advanceSeed(initSeed, this.advanceMin);

      for (let adv = this.advanceMin; adv <= this.advanceMax; adv++) {
        const result = generateMethod1(seed, adv);

        if (isShinyPID(this.tid, this.sid, result.pidHigh, result.pidLow)) {
          foundShiny = true;
          shinySeed = initSeed;
          shinyAdvance = adv;
          shinyNature = NATURE_NAMES[result.nature] || '?';
          break;
        }

        seed = nextSeed(seed);
      }
    }

    if (foundShiny) {
      this.lastHitSeed = shinySeed;
      this.lastShinyAdvance = shinyAdvance;
      this.lastShinyNature = shinyNature;
      logger.info(
        `[Static RNG] *** SHINY SEED HIT! *** Attempt #${this.attempts} | ` +
        `Seed 0x${shinySeed.toString(16).padStart(4, '0')} | ` +
        `Advance ${shinyAdvance} | Nature: ${shinyNature} | ` +
        `Timing: ${aPressMs.toFixed(0)}ms — proceeding with interaction!`
      );
      this.state = 'LOAD_SAVE';
    } else {
      this.skippedSeeds++;
      if (this.attempts % 100 === 0 || this.attempts <= 5) {
        logger.info(
          `[Static RNG] Attempt #${this.attempts} | ` +
          `Seed ~0x${estimatedSeed.toString(16).padStart(4, '0')} | ` +
          `No shiny in [${this.advanceMin}-${this.advanceMax}] | ` +
          `Timing: ${aPressMs.toFixed(0)}ms | ` +
          `Skipped: ${this.skippedSeeds} | Resetting...`
        );
      }
      if (this.attempts % 500 === 0) {
        this.emit('milestone', this.getStatus());
      }
      this.state = 'RESET';
    }
  }

  /**
   * Mash through the remaining title screen, CONTINUE menu, and recap
   * dialogue to reach the overworld. Only called when we've decided
   * to proceed with the interaction (shiny seed detected).
   */
  private async loadSaveAndNavigate(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);

    // Mash A+START to get through remaining title and CONTINUE menu
    for (let i = 0; i < 6 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(400);
    }
    await this.input.pressButton('START', 50);
    await this.wait(300);
    await this.input.pressButton('A', 50);
    await this.wait(300);
    await this.input.pressButton('A', 50);
    await this.wait(2000); // wait for save load

    // Mash through recap dialogue
    for (let i = 0; i < 25 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(220);
    }
    await this.wait(700);

    logger.info('[Static RNG] Save loaded, ready to interact');
  }

  private async interactWithNPC(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);
    await this.executeSequence(seqs.interact);
    logger.info('[Static RNG] Interaction complete, opening summary');
  }

  private async openSummary(): Promise<void> {
    // Safety: if post-interact dialogue is still showing, START is ignored.
    // Mash B a few times to force-close any residual dialogue before trying
    // to open the party menu. B is safer than A here because A could trigger
    // a new NPC conversation if we over-pressed.
    for (let i = 0; i < 8 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(220);
    }
    await this.wait(500);

    await this.input.pressButton('START', 50);
    await this.wait(450);
    await this.input.pressButton('DOWN', 100);
    await this.wait(200);
    await this.input.pressButton('A', 50);
    await this.wait(1700);

    if (this.partySlot >= 2) {
      await this.input.pressButton('RIGHT', 100);
      await this.wait(300);
    }
    for (let i = 3; i <= this.partySlot; i++) {
      await this.input.pressButton('DOWN', 100);
      await this.wait(300);
    }

    await this.input.pressButton('A', 50);
    await this.wait(700);
    await this.input.pressButton('A', 50);
    await this.wait(1600);
  }

  private async readAndProcess(): Promise<void> {
    let frame = await this.frameSource.captureFrame();
    let detection = await detectShiny(frame, this.target, this.game);

    for (let retry = 0; retry < 3 && detection.debugInfo === 'not on summary screen'; retry++) {
      logger.info(`[Static RNG] Summary screen not detected, retry ${retry + 1}/3...`);
      await this.wait(300);
      frame = await this.frameSource.captureFrame();
      detection = await detectShiny(frame, this.target, this.game);
    }

    // Save debug screenshots periodically
    if (this.attempts % 100 === 1) {
      try {
        const debugPath = path.join(process.cwd(), config.paths.screenshots,
          `static-rng-${this.target}-${this.attempts}-${Date.now()}.png`);
        fs.writeFile(debugPath, frame).catch(() => {});
      } catch {}
    }

    let nature: string | null = null;
    let gender: 'male' | 'female' | 'unknown' = 'unknown';

    if (detection.debugInfo !== 'not on summary screen') {
      try {
        const info = await extractSummaryInfo(frame, { skipTID: true });
        nature = info.nature;
        gender = info.gender;
      } catch {}
    }

    // CALIBRATION MODE: read stats on every non-shiny attempt so we can
    // back-solve the true Lapras advance N. IV ranges give ~30 bits of
    // signal per observation vs ~5 bits from nature alone — enough to
    // pin the advance within our ±32-seed timing jitter.
    // Gate behind RNG_CALIBRATE_IVS=true so we can turn this off once
    // the window is locked down and we want speed back.
    let encounterStats: StatValues | null = null;
    let encounterIvRanges: ReturnType<typeof computeIVRanges> = null;
    const calibrateIVs = process.env.RNG_CALIBRATE_IVS === 'true';
    if (
      calibrateIVs &&
      !detection.isShiny &&
      detection.debugInfo !== 'not on summary screen' &&
      nature
    ) {
      await this.input.pressButton('RIGHT', 100);
      await this.wait(1400);
      for (let r = 0; r < 3 && !encounterStats; r++) {
        const sFrame = await this.frameSource.captureFrame();
        encounterStats = await extractStats(sFrame);
        if (!encounterStats) await this.wait(300);
      }
      if (encounterStats) {
        encounterIvRanges = computeIVRanges(this.target, 25, nature, encounterStats);
      }
    }

    const aPressMs = this.aPressTimestamp - this.bootTimestamp;
    let logLine = `[Static RNG] Visual check | ` +
      `${detection.isShiny ? '*** SHINY! ***' : 'normal'} | ` +
      `Seed 0x${this.lastHitSeed.toString(16).padStart(4, '0')} adv ${this.lastShinyAdvance} | ` +
      `Nature: ${nature ?? '?'} (predicted: ${this.lastShinyNature}) | ` +
      `Gender: ${gender} | aPressMs=${aPressMs.toFixed(1)} | ${detection.debugInfo}`;
    if (encounterStats) {
      logLine += ` | stats=${encounterStats.hp}/${encounterStats.attack}/${encounterStats.defense}/${encounterStats.spAtk}/${encounterStats.spDef}/${encounterStats.speed}`;
    }
    if (encounterIvRanges) {
      logLine += ` | IVs HP:${encounterIvRanges.hp.join(',')} ATK:${encounterIvRanges.atk.join(',')} DEF:${encounterIvRanges.def.join(',')} SPA:${encounterIvRanges.spa.join(',')} SPD:${encounterIvRanges.spd.join(',')} SPE:${encounterIvRanges.spe.join(',')}`;
    }
    logger.info(logLine);

    this.encounterLog.push({
      attempt: this.attempts,
      time: Date.now(),
      nature: nature ?? '?',
      gender,
      isShiny: detection.isShiny,
      detectionDebug: detection.debugInfo ?? '',
      seed: `0x${this.lastHitSeed.toString(16).padStart(4, '0')}`,
      shinyAdvance: this.lastShinyAdvance,
    });
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (detection.isShiny) {
      const ts = Date.now();
      // Save summary page 1
      const screenshotPath = path.join(process.cwd(), config.paths.screenshots,
        `static-rng-shiny-${this.target}-${ts}.png`);
      await fs.writeFile(screenshotPath, frame);
      logger.info(`[Static RNG] *** SHINY SUMMARY saved: ${screenshotPath}`);

      // Navigate to stats page and read stats
      await this.input.pressButton('RIGHT', 100);
      await this.wait(2000);
      let shinyStats: StatValues | null = null;
      for (let retry = 0; retry < 5 && !shinyStats; retry++) {
        const statsFrame = await this.frameSource.captureFrame();
        const statsPath = path.join(process.cwd(), config.paths.screenshots,
          `static-rng-shiny-${this.target}-STATS-${ts}-${retry}.png`);
        await fs.writeFile(statsPath, statsFrame);
        shinyStats = await extractStats(statsFrame);
        if (!shinyStats) await this.wait(500);
      }

      if (shinyStats) {
        logger.info(`[Static RNG] *** SHINY STATS: HP:${shinyStats.hp} ATK:${shinyStats.attack} DEF:${shinyStats.defense} SPA:${shinyStats.spAtk} SPD:${shinyStats.spDef} SPE:${shinyStats.speed}`);
        if (nature) {
          const ranges = computeIVRanges(this.target, 24, nature, shinyStats);
          if (ranges) {
            logger.info(`[Static RNG] *** SHINY IVs: HP:${ranges.hp} ATK:${ranges.atk} DEF:${ranges.def} SPA:${ranges.spa} SPD:${ranges.spd} SPE:${ranges.spe}`);
          }
        }
      } else {
        logger.warn('[Static RNG] *** Could not read shiny stats — check screenshots manually');
      }

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        nature: nature ?? '?',
        gender,
        stats: shinyStats,
        seed: `0x${this.lastHitSeed.toString(16).padStart(4, '0')}`,
        advance: this.lastShinyAdvance,
        skippedSeeds: this.skippedSeeds,
      });
      this.state = 'SHINY_FOUND';
      return;
    }

    // Not shiny despite RNG prediction — possible timing miss or advance drift
    logger.warn(
      `[Static RNG] RNG predicted shiny but visual check says normal. ` +
      `Seed 0x${this.lastHitSeed.toString(16).padStart(4, '0')} adv ${this.lastShinyAdvance}. ` +
      `The timing may have drifted or the advance window needs adjustment.`
    );

    if (this.attempts % 100 === 0) {
      this.emit('milestone', this.getStatus());
    }
    this.state = 'RESET';
  }

  private async executeSequence(sequence: ButtonSequence): Promise<void> {
    for (const step of sequence) {
      if (!this.running) return;
      switch (step.action) {
        case 'press':
          this.logFC(`press ${step.keys.join('+')} hold=${step.holdMs}`);
          await this.input.pressButtons(step.keys, step.holdMs);
          break;
        case 'wait':
          this.logFC(`wait ${step.ms}ms`);
          await this.wait(step.ms);
          break;
        case 'mashA':
          for (let i = 0; i < step.count && this.running; i++) {
            this.logFC(`mashA ${i + 1}/${step.count}`);
            await this.input.pressButton('A', 50);
            await this.wait(step.intervalMs);
          }
          break;
        case 'mashB':
          for (let i = 0; i < step.count && this.running; i++) {
            this.logFC(`mashB ${i + 1}/${step.count}`);
            await this.input.pressButton('B', 50);
            await this.wait(step.intervalMs);
          }
          break;
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
