import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, GBAButton, ButtonSequence } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { extractStats, StatValues } from '../detection/stats-ocr';
import { computeIVRanges } from './iv-calc';
import { getStaticSequences } from './sequences';

type StaticHuntState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TITLE_AND_LOAD'
  | 'INTERACT'
  | 'OPEN_SUMMARY'
  | 'READ_RESULT'
  | 'SHINY_FOUND'
  | 'RESET';

export class StaticHuntEngine extends EventEmitter {
  private state: StaticHuntState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private partySlot: number;

  public encounterLog: Array<{
    attempt: number;
    time: number;
    nature: string;
    gender: string;
    isShiny: boolean;
    detectionDebug: string;
    stats?: StatValues;
    ivRanges?: string;
  }> = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    this.partySlot = parseInt(process.env.PARTY_SLOT || '2', 10);
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
    logger.info(`[Static Hunt] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Static Hunt] Party slot: ${this.partySlot}`);
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
        logger.error(`[Static Hunt] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[Static Hunt] Stopping after ${this.attempts} attempts`);
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
        // Switch Sloop uses hardware entropy for seeds (proven via chi-squared test).
        // No need for random timing variation. Just wait for boot to finish.
        await this.wait(config.env === 'switch' ? 2500 : 3000);
        this.state = 'TITLE_AND_LOAD';
        break;
      case 'TITLE_AND_LOAD':
        await this.titleAndLoad();
        break;
      case 'INTERACT':
        await this.interactWithNPC();
        break;
      case 'OPEN_SUMMARY':
        await this.openSummary();
        break;
      case 'READ_RESULT':
        await this.readAndProcess();
        break;
      case 'SHINY_FOUND':
        logger.info('[Static Hunt] *** SHINY FOUND! ***');
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

    // Title screen — A spam + START presses
    await this.executeSequence(seqs.title);

    // Load save — select CONTINUE
    await this.executeSequence(seqs.loadSave);

    // B-spam through recap dialogue — tightened for speed
    for (let i = 0; i < 20 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(150);
    }
    await this.wait(400);

    logger.info('[Static Hunt] Save loaded, ready to interact');
    this.state = 'INTERACT';
  }

  private async interactWithNPC(): Promise<void> {
    // No random delay needed — Switch Sloop uses hardware entropy for seeds.
    const seqs = getStaticSequences(this.game, this.target);
    await this.executeSequence(seqs.interact);
    logger.info('[Static Hunt] Interaction complete, opening summary');
    this.state = 'OPEN_SUMMARY';
  }

  private async openSummary(): Promise<void> {
    // Open party menu — tightened timings for speed
    await this.input.pressButton('START', 50);
    await this.wait(400);
    await this.input.pressButton('DOWN', 50);
    await this.wait(150);
    await this.input.pressButton('A', 50);
    await this.wait(1500); // Party screen load

    // Navigate to slot 2
    if (this.partySlot >= 2) {
      await this.input.pressButton('RIGHT', 100);
      await this.wait(250);
    }
    for (let i = 3; i <= this.partySlot; i++) {
      await this.input.pressButton('DOWN', 100);
      await this.wait(250);
    }

    // Select + Summary
    await this.input.pressButton('A', 50);
    await this.wait(500);
    await this.input.pressButton('A', 50);
    await this.wait(1400); // Summary screen load

    this.state = 'READ_RESULT';
  }

  private async readAndProcess(): Promise<void> {
    this.attempts++;

    let frame = await this.frameSource.captureFrame();
    let detection = await detectShiny(frame, this.target, this.game);

    for (let retry = 0; retry < 3 && detection.debugInfo === 'not on summary screen'; retry++) {
      logger.info(`[Static Hunt] Summary screen not detected, retry ${retry + 1}/3...`);
      await this.wait(300);
      frame = await this.frameSource.captureFrame();
      detection = await detectShiny(frame, this.target, this.game);
    }

    if (this.attempts % 100 === 1) {
      try {
        const debugPath = path.join(process.cwd(), config.paths.screenshots,
          `static-${this.target}-${this.attempts}-${Date.now()}.png`);
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

    const logLine = `[Static Hunt] Attempt #${this.attempts} | ` +
      `${detection.isShiny ? '*** SHINY! ***' : 'normal'} | ` +
      `Nature: ${nature ?? '?'} | Gender: ${gender} | ` +
      `${detection.debugInfo}`;
    logger.info(logLine);

    this.encounterLog.push({
      attempt: this.attempts,
      time: Date.now(),
      nature: nature ?? '?',
      gender,
      isShiny: detection.isShiny,
      detectionDebug: detection.debugInfo ?? '',
    });
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (detection.isShiny) {
      const ts = Date.now();
      // Save summary page 1 (info + shiny border)
      const screenshotPath = path.join(process.cwd(), config.paths.screenshots,
        `static-shiny-${this.target}-${ts}.png`);
      await fs.writeFile(screenshotPath, frame);
      logger.info(`[Static Hunt] *** SHINY SUMMARY saved: ${screenshotPath}`);

      // Navigate to stats page (RIGHT) and read stats for SID deduction
      await this.input.pressButton('RIGHT', 100);
      await this.wait(2000);
      let shinyStats: StatValues | null = null;
      for (let retry = 0; retry < 5 && !shinyStats; retry++) {
        const statsFrame = await this.frameSource.captureFrame();
        const statsPath = path.join(process.cwd(), config.paths.screenshots,
          `static-shiny-${this.target}-STATS-${ts}-${retry}.png`);
        await fs.writeFile(statsPath, statsFrame);
        shinyStats = await extractStats(statsFrame);
        if (!shinyStats) await this.wait(500);
      }

      if (shinyStats) {
        logger.info(`[Static Hunt] *** SHINY STATS: HP:${shinyStats.hp} ATK:${shinyStats.attack} DEF:${shinyStats.defense} SPA:${shinyStats.spAtk} SPD:${shinyStats.spDef} SPE:${shinyStats.speed}`);
        if (nature) {
          const ranges = computeIVRanges(this.target, 24, nature, shinyStats);
          if (ranges) {
            logger.info(`[Static Hunt] *** SHINY IVs: HP:${ranges.hp} ATK:${ranges.atk} DEF:${ranges.def} SPA:${ranges.spa} SPD:${ranges.spd} SPE:${ranges.spe}`);
          }
        }
      } else {
        logger.warn('[Static Hunt] *** Could not read shiny stats — check screenshots manually');
      }

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        nature: nature ?? '?',
        gender,
        stats: shinyStats,
      });
      this.state = 'SHINY_FOUND';
      return;
    }

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
          await this.input.pressButtons(step.keys, step.holdMs);
          break;
        case 'wait':
          await this.wait(step.ms);
          break;
        case 'mashA':
          for (let i = 0; i < step.count && this.running; i++) {
            await this.input.pressButton('A', 50);
            await this.wait(step.intervalMs);
          }
          break;
        case 'mashB':
          for (let i = 0; i < step.count && this.running; i++) {
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
