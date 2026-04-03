import { config } from './config';
import { logger } from './logger';
import { initDb } from './db';
import { InputController, FrameSource } from './types';
import { EmulatorInput } from './drivers/emulator-input';
import { EmulatorFrames } from './drivers/emulator-frames';
import { SwitchInput } from './drivers/switch-input';
import { CaptureCardFrames } from './drivers/capture-card-frames';
import { HuntEngine } from './engine/hunt-engine';
import { RngEngine } from './engine/rng-engine';
import { SwitchRngEngine } from './engine/rng-switch';
import { WildHuntEngine } from './engine/wild-hunt';
import { StaticHuntEngine } from './engine/static-hunt';
import { StaticRngEngine } from './engine/static-rng';
import { SuspendRngEngine } from './engine/suspend-rng';
import { startServer } from './server';
import {
  createHunt,
  endHunt,
  updateHuntEncounters,
  recordShinyFind,
} from './services/stats';
import {
  notifyShinyFound,
  notifyMilestone,
  notifyHuntStarted,
  notifyHuntStopped,
  notifyDailySummary,
} from './services/discord';
import { saveHuntState, loadHuntState, PersistedHuntState } from './hunt-state';

async function main() {
  logger.info('=== Shiny Hunter starting ===');
  logger.info(`Target: ${config.hunt.target} | Game: ${config.hunt.game} | Env: ${config.env} | Type: ${config.hunt.huntType}`);

  // Init database
  initDb();

  // Init drivers based on environment
  let input: InputController;
  let frames: FrameSource;

  if (config.env === 'switch') {
    logger.info('Environment: Switch hardware (ESP32 serial + capture card)');
    const switchInput = new SwitchInput();
    const captureFrames = new CaptureCardFrames();
    input = switchInput;
    frames = captureFrames;

    try {
      await switchInput.init();
      await captureFrames.init();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to init Switch drivers: ${msg}`);
      logger.info('Check SWITCH_SERIAL_PORT and CAPTURE_DEVICE in .env');
      logger.info('Starting server without hunt capability...');
    }
  } else {
    logger.info('Environment: Emulator (mGBA Lua bridge)');
    const emuInput = new EmulatorInput();
    const emuFrames = new EmulatorFrames(emuInput);
    input = emuInput;
    frames = emuFrames;

    try {
      await emuInput.init();
      await emuFrames.init();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to connect to mGBA: ${msg}`);
      logger.info('Make sure mGBA is running with lua/bridge.lua loaded.');
      logger.info('Starting server without hunt capability...');
    }
  }

  // Create hunt engine based on mode + environment + hunt type
  let engine: HuntEngine | RngEngine | SwitchRngEngine | WildHuntEngine | StaticHuntEngine | StaticRngEngine | SuspendRngEngine;

  if (config.hunt.huntType === 'wild') {
    logger.info(`Mode: Wild encounter hunting (${config.hunt.target} in ${config.hunt.game})`);
    engine = new WildHuntEngine(frames, input);
  } else if (config.hunt.huntType === 'static' && config.hunt.mode === 'switch-rng') {
    logger.info(`Mode: Static encounter + RNG boot timing (${config.hunt.target} in ${config.hunt.game})`);
    engine = new StaticRngEngine(frames, input);
  } else if (config.hunt.huntType === 'static') {
    logger.info(`Mode: Static encounter hunting (${config.hunt.target} in ${config.hunt.game})`);
    engine = new StaticHuntEngine(frames, input);
  } else if (config.hunt.mode === 'rng') {
    if (config.env === 'switch') {
      throw new Error('RNG mode requires emulator (memory reads). Use hunt mode "reset" or "switch-rng" for Switch hardware.');
    }
    logger.info('Mode: RNG manipulation (emulator — memory reads)');
    const rng = new RngEngine(frames, input as EmulatorInput);
    if (config.hunt.targetNature) rng.setTargetNature(config.hunt.targetNature);
    engine = rng;
  } else if (config.hunt.mode === 'suspend-rng') {
    logger.info('Mode: Suspend-point RNG (frame counting + suspend points)');
    engine = new SuspendRngEngine(frames, input);
  } else if (config.hunt.mode === 'switch-rng') {
    logger.info('Mode: Switch RNG (blind timing — no memory reads)');
    engine = new SwitchRngEngine(frames, input);
  } else {
    logger.info('Mode: Soft reset hunting');
    engine = new HuntEngine(frames, input);
  }

  // Stop hunt if capture card loses signal (Switch undocked).
  // Only trigger if hunt has been running >30s to avoid false positives
  // from stale counter that accumulated before the hunt started.
  if (frames instanceof CaptureCardFrames) {
    frames.onSignalLost = () => {
      const status = engine.getStatus();
      if (status.running && status.elapsedSeconds > 30) {
        logger.info('[Signal] Capture card signal lost — stopping hunt');
        engine.stop();
      }
    };
  }

  // Track active hunt in DB
  let currentHuntId: number | null = null;

  engine.on('started', async (status) => {
    currentHuntId = createHunt(status.target, status.game);
    saveHuntState({
      hunting: true,
      target: status.target,
      game: status.game,
      huntType: config.hunt.huntType,
      huntMode: config.hunt.mode,
      encounters: 0,
      startedAt: status.startedAt,
      savedAt: Date.now(),
    });
    await notifyHuntStarted(status.target, status.game);
  });

  let isShuttingDown = false;

  engine.on('stopped', async (status) => {
    if (currentHuntId) {
      endHunt(currentHuntId, 'abandoned', status.encounters);
    }
    // Only write hunting: false for manual stops, not during shutdown.
    // During shutdown, we already saved hunting: true so auto-resume works.
    if (!isShuttingDown) {
      saveHuntState({
        hunting: false,
        target: status.target,
        game: status.game,
        huntType: config.hunt.huntType,
        huntMode: config.hunt.mode,
        encounters: status.encounters,
        startedAt: status.startedAt,
        savedAt: Date.now(),
      });
    }
    await notifyHuntStopped(status);
    currentHuntId = null;
  });

  engine.on('shiny', async (event) => {
    if (currentHuntId) {
      recordShinyFind(
        currentHuntId,
        event.pokemon,
        event.encounters,
        event.elapsedSeconds,
        event.screenshotPath
      );
      endHunt(currentHuntId, 'found', event.encounters);
    }
    saveHuntState({
      hunting: false,
      target: event.pokemon,
      game: config.hunt.game,
      huntType: config.hunt.huntType,
      huntMode: config.hunt.mode,
      encounters: event.encounters,
      startedAt: null,
      savedAt: Date.now(),
    });
    await notifyShinyFound(event);
    currentHuntId = null;
  });

  engine.on('milestone', async (status) => {
    if (currentHuntId) {
      updateHuntEncounters(currentHuntId, status.encounters);
    }
    await notifyMilestone(status);
  });

  // Periodic state save (every 10s) - keeps hunt-state.json fresh for auto-resume on SIGKILL
  let lastSavedEncounters = 0;
  const saveInterval = setInterval(() => {
    if (currentHuntId && engine.getStatus().running) {
      const status = engine.getStatus();
      const enc = status.encounters;
      // Always persist hunt state for auto-resume
      saveHuntState({
        hunting: true,
        target: status.target,
        game: status.game,
        huntType: config.hunt.huntType,
        huntMode: config.hunt.mode,
        encounters: enc,
        startedAt: status.startedAt,
        savedAt: Date.now(),
      });
      // Update DB every 50 encounters
      if (enc - lastSavedEncounters >= 50) {
        updateHuntEncounters(currentHuntId, enc);
        lastSavedEncounters = enc;
      }
    }
  }, 10000);

  // Daily Discord summary — tracks encounters per day
  let dailyEncounters = 0;
  let dailyShinies = 0;
  let dailyActiveSeconds = 0;
  let dailyLastCheck = Date.now();

  // Update daily counters on each encounter check
  engine.on('milestone', () => {
    // milestone fires every 500, but we track continuously via the status
  });

  const dailyTracker = setInterval(() => {
    if (engine.getStatus().running) {
      const now = Date.now();
      dailyActiveSeconds += (now - dailyLastCheck) / 1000;
      dailyLastCheck = now;
    } else {
      dailyLastCheck = Date.now();
    }
  }, 60000); // update active time every minute

  // Send daily summary every 24 hours
  const dailySummaryInterval = setInterval(async () => {
    const status = engine.getStatus();
    const todayEncounters = status.running
      ? status.encounters - (lastSavedEncounters - dailyEncounters) + dailyEncounters
      : dailyEncounters;

    // Use actual encounter count from status for accuracy
    const activeHours = dailyActiveSeconds / 3600;
    const avgRate = activeHours > 0 ? Math.round(dailyEncounters / activeHours) : 0;

    if (dailyEncounters > 0) {
      await notifyDailySummary({
        encounters: dailyEncounters,
        shinies: dailyShinies,
        hoursActive: activeHours,
        avgRate,
        target: config.hunt.target,
        game: config.hunt.game,
      });
    }

    // Reset daily counters
    dailyEncounters = 0;
    dailyShinies = 0;
    dailyActiveSeconds = 0;
    dailyLastCheck = Date.now();
  }, 24 * 60 * 60 * 1000); // every 24 hours

  // Track daily encounters from the engine's encounter event
  let lastKnownEncounters = 0;
  const encounterTracker = setInterval(() => {
    if (engine.getStatus().running) {
      const current = engine.getStatus().encounters;
      if (current > lastKnownEncounters) {
        dailyEncounters += current - lastKnownEncounters;
        lastKnownEncounters = current;
      }
    }
  }, 5000); // check every 5 seconds

  // Reset lastKnownEncounters when a new hunt starts
  engine.on('started', () => {
    lastKnownEncounters = 0;
    dailyLastCheck = Date.now();
  });

  engine.on('shiny', () => {
    dailyShinies++;
  });

  // Start Express server (pass frame source for live view + input controller for debug)
  startServer(engine, frames, input);

  // Auto-resume: if we were hunting when we last shut down, restart automatically
  const savedState = loadHuntState();
  if (savedState && savedState.hunting) {
    // Verify the saved state matches current config (target/game/hunt type)
    const configMatch =
      savedState.target === config.hunt.target &&
      savedState.game === config.hunt.game &&
      savedState.huntType === config.hunt.huntType;

    if (configMatch) {
      logger.info(`Auto-resuming hunt: ${savedState.target} in ${savedState.game} (was at ${savedState.encounters} encounters)`);
      engine.start().catch((err) => {
        logger.error(`Auto-resume hunt failed: ${err.message}`);
      });
    } else {
      logger.info(
        `Saved hunt state found but config changed ` +
        `(saved: ${savedState.target}/${savedState.game}/${savedState.huntType}, ` +
        `current: ${config.hunt.target}/${config.hunt.game}/${config.hunt.huntType}). ` +
        `Skipping auto-resume.`
      );
      saveHuntState({ ...savedState, hunting: false, savedAt: Date.now() });
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    isShuttingDown = true;
    logger.info('Shutting down...');
    clearInterval(saveInterval);
    clearInterval(dailyTracker);
    clearInterval(dailySummaryInterval);
    clearInterval(encounterTracker);

    // Persist hunt state before stopping so auto-resume works on restart
    const status = engine.getStatus();
    if (status.running) {
      saveHuntState({
        hunting: true,
        target: status.target,
        game: status.game,
        huntType: config.hunt.huntType,
        huntMode: config.hunt.mode,
        encounters: status.encounters,
        startedAt: status.startedAt,
        savedAt: Date.now(),
      });
      logger.info(`Hunt state saved for auto-resume (${status.encounters} encounters)`);
    }

    engine.stop();
    await input.cleanup();
    await frames.cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('=== Shiny Hunter ready ===');
  logger.info(`API: http://localhost:${config.server.port}/api/status`);
  logger.info('POST /api/hunt/start to begin hunting');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
