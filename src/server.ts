import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { IHuntEngine, FrameSource, InputController, GBAButton } from './types';
import { getAllHunts, getShinyFinds, getHuntStats } from './services/stats';
import { SwitchRngEngine } from './engine/rng-switch';
import { WildHuntEngine } from './engine/wild-hunt';
import { StaticHuntEngine } from './engine/static-hunt';
import { StaticRngEngine } from './engine/static-rng';
import { SuspendRngEngine } from './engine/suspend-rng';
import { detectShiny } from './detection/shiny-detector';
import path from 'path';
import fs from 'fs/promises';

export function createServer(engine: IHuntEngine, frameSource?: FrameSource, inputController?: InputController): express.Application {
  const app = express();
  app.use(express.json());

  // Live frame endpoint — serves the latest cached frame as PNG.
  // NEVER captures a fresh frame here to avoid racing with the hunt engine
  // for the capture device (causes webcam swap when two ffmpeg hit it).
  if (frameSource) {
    app.get('/api/frame', async (_req, res) => {
      try {
        const cached = frameSource.getLatestFrame?.();
        if (cached) {
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'no-cache');
          res.send(cached.frame);
        } else {
          // No cached frame yet — hunt hasn't started or no frames captured
          // Return a 1x1 transparent PNG placeholder
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'no-cache');
          const placeholder = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
            'Nl7BcQAAAABJRU5ErkJggg==', 'base64'
          );
          res.send(placeholder);
        }
      } catch (err) {
        res.status(500).json({ error: 'frame unavailable' });
      }
    });
  }

  // MJPEG live stream -- reads raw JPEG from capture card for smooth viewing
  if (frameSource) {
    app.get('/api/stream', async (req, res) => {
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      let running = true;
      req.on('close', () => { running = false; });

      const fs = await import('fs/promises');
      const jpegPath = '/tmp/shiny-hunter-live.jpg';

      while (running) {
        try {
          // Read raw JPEG directly from ffmpeg's output file -- no sharp processing
          const raw = await fs.readFile(jpegPath);
          if (raw.length > 500) {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${raw.length}\r\n\r\n`);
            res.write(raw);
            res.write('\r\n');
          }
        } catch {
          // File not ready, skip
        }
        // ~20 FPS for smoother viewing
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
  }

  // Manual button press for debugging (only when hunt is NOT running)
  if (inputController) {
    app.post('/api/button', async (req, res) => {
      if (engine.getStatus().running) {
        res.status(400).json({ error: 'Cannot send buttons while hunt is running' });
        return;
      }
      const { button, holdMs } = req.body;
      const validButtons: GBAButton[] = ['A', 'B', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'L', 'R'];
      if (!validButtons.includes(button)) {
        res.status(400).json({ error: `Invalid button: ${button}. Valid: ${validButtons.join(', ')}` });
        return;
      }
      try {
        await inputController.pressButton(button, holdMs || 100);
        res.json({ ok: true, button, holdMs: holdMs || 100 });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post('/api/reset', async (_req, res) => {
      if (engine.getStatus().running) {
        res.status(400).json({ error: 'Cannot reset while hunt is running' });
        return;
      }
      try {
        await inputController.softReset();
        res.json({ ok: true, action: 'soft_reset' });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }

  // Debug: capture + process frame and save as PNG, run shiny detection
  if (frameSource) {
    app.post('/api/debug/frame', async (_req, res) => {
      try {
        const frame = await frameSource.captureFrame();
        const target = config.hunt.target;
        const game = config.hunt.game;
        const detection = await detectShiny(frame, target, game);
        const filename = `debug-manual-${Date.now()}.png`;
        const savePath = path.join(process.cwd(), config.paths.screenshots, filename);
        await fs.writeFile(savePath, frame);
        res.json({
          saved: savePath,
          filename,
          detection,
          frameSize: frame.length,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }

  // Current hunt status
  app.get('/api/status', (_req, res) => {
    const status = engine.getStatus();
    const stats = getHuntStats();
    res.json({ ...status, lifetime: stats });
  });

  // Hunt history
  app.get('/api/history', (_req, res) => {
    const hunts = getAllHunts();
    const finds = getShinyFinds();
    res.json({ hunts, finds });
  });

  // Start a new hunt
  app.post('/api/hunt/start', async (_req, res) => {
    if (engine.getStatus().running) {
      res.status(400).json({ error: 'Hunt already running' });
      return;
    }

    // Start hunt in background (don't await — it runs indefinitely)
    engine.start().catch((err) => {
      logger.error(`Hunt failed: ${err.message}`);
    });

    res.json({ message: 'Hunt started', status: engine.getStatus() });
  });

  // Stop current hunt
  app.post('/api/hunt/stop', (_req, res) => {
    if (!engine.getStatus().running) {
      res.status(400).json({ error: 'No hunt running' });
      return;
    }

    engine.stop();
    res.json({ message: 'Hunt stopped', status: engine.getStatus() });
  });

  // Lifetime stats
  app.get('/api/stats', (_req, res) => {
    res.json(getHuntStats());
  });

  // === Switch RNG Calibration API ===

  if (engine instanceof SwitchRngEngine) {
    const switchEngine = engine;

    app.get('/api/rng/calibration', (_req, res) => {
      const cal = switchEngine.getCalibrationState();
      const remainingSIDs = cal.sidCandidates.filter(s => !s.eliminated).length;
      res.json({
        phase: cal.phase,
        tid: cal.tid,
        sid: cal.sid,
        observations: cal.observations.length,
        pidObservations: cal.pidObservations.length,
        remainingSIDs,
        totalSIDCandidates: cal.sidCandidates.length,
        shinyTarget: cal.shinyTarget,
        allTargetsCount: cal.allShinyTargets.length,
        advanceWindow: cal.advanceWindow,
        advanceHits: cal.advanceHits,
        advanceWindowLocked: cal.advanceWindowLocked,
        timingOffset: cal.timingOffsetMs,
      });
    });

    app.get('/api/rng/sid-status', (_req, res) => {
      const cal = switchEngine.getCalibrationState();
      const alive = cal.sidCandidates.filter(s => !s.eliminated);
      res.json({
        phase: cal.phase,
        tid: cal.tid,
        sid: cal.sid,
        pidObservations: cal.pidObservations.map(p => ({
          attempt: p.attempt,
          pid: `0x${(p.pid >>> 0).toString(16).padStart(8, '0')}`,
          nature: p.nature,
          isShiny: p.isShiny,
        })),
        remainingSIDs: alive.length,
        topCandidates: alive.slice(0, 10).map(s => ({
          sid: s.sid,
          sidHex: `0x${s.sid.toString(16).padStart(4, '0')}`,
          matchingObs: s.matchingObs,
          totalObs: s.totalObs,
        })),
      });
    });

    app.post('/api/rng/tid', async (req, res) => {
      const { tid } = req.body;
      if (typeof tid !== 'number' || tid < 0 || tid > 65535) {
        res.status(400).json({ error: 'tid must be 0-65535' });
        return;
      }
      await switchEngine.setTID(tid);
      const cal = switchEngine.getCalibrationState();
      res.json({
        message: `TID set to ${tid}. ${cal.sidCandidates.length} SID candidates found.`,
        phase: cal.phase,
        sidCandidates: cal.sidCandidates.length,
      });
    });

    app.post('/api/rng/sid', async (req, res) => {
      const { sid } = req.body;
      if (typeof sid !== 'number' || sid < 0 || sid > 65535) {
        res.status(400).json({ error: 'sid must be 0-65535' });
        return;
      }
      await switchEngine.setSID(sid);
      const cal = switchEngine.getCalibrationState();
      res.json({
        message: `SID set to ${sid}. ${cal.allShinyTargets.length} shiny targets found.`,
        phase: cal.phase,
        shinyTarget: cal.shinyTarget,
      });
    });

    app.get('/api/rng/targets', (_req, res) => {
      const cal = switchEngine.getCalibrationState();
      res.json({
        targets: cal.allShinyTargets.map((t, i) => ({
          index: i,
          seed: `0x${t.initialSeed.toString(16).padStart(4, '0')}`,
          advance: t.advance,
          nature: t.nature,
          ivs: t.ivs,
          bootTimingMs: t.targetBootTimingMs,
        })),
      });
    });

    app.post('/api/rng/skip-sid', async (_req, res) => {
      const cal = switchEngine.getCalibrationState();
      if (cal.tid === null) {
        res.status(400).json({ error: 'TID must be set first' });
        return;
      }
      const result = await switchEngine.skipSIDDeduction();
      res.json({
        message: `Multi-SID targeting active. ${result.seedCount} seeds in schedule, best seed covers ${result.topSeedSIDs} SIDs.`,
        phase: 'MULTI_SID_TARGETING',
        seedCount: result.seedCount,
        topSeedSIDs: result.topSeedSIDs,
      });
    });

    // Encounter log for dashboard
    app.get('/api/rng/encounters', (_req, res) => {
      const cal = switchEngine.getCalibrationState();
      const activeSIDs = cal.sidCandidates.filter(s => !s.eliminated).length;
      const status = switchEngine.getStatus();
      const elapsed = status.startedAt ? (Date.now() - status.startedAt) / 1000 : 0;
      const rate = elapsed > 0 ? (status.encounters / elapsed) * 3600 : 0;

      // Multi-SID odds: sidCount / scheduleSIDCount gives the fraction of SIDs covered.
      // Use the SID count from when the schedule was built (not current activeSIDs),
      // because sidCount in the schedule reflects that snapshot. As SIDs get eliminated,
      // activeSIDs drops but sidCount stays stale — using activeSIDs in the denominator
      // would make odds appear to worsen when they should improve.
      const lastEntry = switchEngine.encounterLog.length > 0
        ? switchEngine.encounterLog[switchEngine.encounterLog.length - 1]
        : null;
      const lastSIDCoverage = lastEntry?.targetSIDs ?? 35;
      const scheduleSIDCount = switchEngine.getScheduleSIDCount() || activeSIDs;
      const multiSIDOdds = scheduleSIDCount > 0 && lastSIDCoverage > 0
        ? Math.round(1 / ((lastSIDCoverage / scheduleSIDCount) * (1 / 201)))
        : 8192;

      res.json({
        encounters: status.encounters,
        elapsed: Math.round(elapsed),
        rate: Math.round(rate),
        standardOdds: 8192,
        multiSIDOdds,
        activeSIDs,
        eliminatedSIDs: cal.sidCandidates.length - activeSIDs,
        pidObservations: cal.pidObservations.length,
        scheduledSeeds: switchEngine.getSeedSchedule().length,
        advanceWindow: `${cal.advanceWindow.min}-${cal.advanceWindow.max}`,
        advanceHits: cal.advanceHits?.length || 0,
        timingOffset: cal.timingOffsetMs,
        log: switchEngine.encounterLog.slice(-50).reverse(),
      });
    });

    // Live dashboard HTML
    app.get('/dashboard', (_req, res) => {
      res.send(DASHBOARD_HTML);
    });

    app.post('/api/rng/target', async (req, res) => {
      const { index } = req.body;
      if (typeof index !== 'number') {
        res.status(400).json({ error: 'index required' });
        return;
      }
      await switchEngine.selectTarget(index);
      const cal = switchEngine.getCalibrationState();
      res.json({
        message: `Target ${index} selected`,
        shinyTarget: cal.shinyTarget,
      });
    });
  }

  // === Wild Hunt API ===
  if (engine instanceof WildHuntEngine) {
    const wildEngine = engine;

    app.get('/api/wild/encounters', (_req, res) => {
      const status = wildEngine.getStatus();
      const elapsed = status.startedAt ? (Date.now() - status.startedAt) / 1000 : 0;
      const rate = elapsed > 0 ? (status.encounters / elapsed) * 3600 : 0;
      res.json({
        encounters: status.encounters,
        elapsed: Math.round(elapsed),
        rate: Math.round(rate),
        log: wildEngine.encounterLog.slice(-50).reverse(),
      });
    });

    app.get('/dashboard', (_req, res) => {
      res.send(WILD_DASHBOARD_HTML);
    });
  }

  // === Static Hunt API ===
  if (engine instanceof StaticHuntEngine || engine instanceof StaticRngEngine) {
    const staticEngine = engine;

    app.get('/api/static/encounters', (_req, res) => {
      const status = staticEngine.getStatus();
      const elapsed = status.startedAt ? (Date.now() - status.startedAt) / 1000 : 0;
      const rate = elapsed > 0 ? (status.encounters / elapsed) * 3600 : 0;
      res.json({
        encounters: status.encounters,
        elapsed: Math.round(elapsed),
        rate: Math.round(rate),
        target: status.target,
        log: staticEngine.encounterLog.slice(-50).reverse(),
      });
    });

    app.get('/dashboard', (_req, res) => {
      res.send(STATIC_DASHBOARD_HTML);
    });
  }

  // === Suspend RNG API ===
  if (engine instanceof SuspendRngEngine) {
    const suspendEngine = engine;

    app.get('/api/suspend/encounters', (_req, res) => {
      const status = suspendEngine.getStatus();
      const elapsed = status.startedAt ? (Date.now() - status.startedAt) / 1000 : 0;
      const rate = elapsed > 0 ? (status.encounters / elapsed) * 3600 : 0;
      const cal = suspendEngine.getCalibration();
      const fcStats = suspendEngine.getFrameCounterStats();
      res.json({
        encounters: status.encounters,
        elapsed: Math.round(elapsed),
        rate: Math.round(rate),
        target: status.target,
        calibration: {
          complete: cal.calibrationComplete,
          observations: cal.observations.length,
          frameToAdvanceOffset: cal.frameToAdvanceOffset,
          initialSeed: `0x${cal.initialSeed.toString(16).padStart(8, '0')}`,
        },
        frameCounter: fcStats,
        log: suspendEngine.encounterLog.slice(-50).reverse(),
      });
    });

    app.get('/api/suspend/calibration', (_req, res) => {
      const cal = suspendEngine.getCalibration();
      res.json({
        tid: cal.tid,
        sid: cal.sid,
        initialSeed: `0x${cal.initialSeed.toString(16).padStart(8, '0')}`,
        observations: cal.observations,
        frameToAdvanceOffset: cal.frameToAdvanceOffset,
        advancesPerFrame: cal.advancesPerFrame,
        calibrationComplete: cal.calibrationComplete,
        lastUpdated: cal.lastUpdated,
      });
    });

    app.get('/dashboard', (_req, res) => {
      res.send(SUSPEND_DASHBOARD_HTML);
    });
  }

  return app;
}

const STATIC_DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Static Hunt Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, monospace; background: #1a1a2e; color: #e0e0e0; padding: 16px; }
  h1 { color: #ffd700; font-size: 20px; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: #16213e; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .val { font-size: 24px; font-weight: bold; color: #00d4ff; }
  .stat .label { font-size: 11px; color: #888; margin-top: 4px; }
  .odds { color: #ffd700; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #16213e; color: #888; padding: 6px 8px; text-align: left; position: sticky; top: 0; }
  td { padding: 5px 8px; border-bottom: 1px solid #222; }
  tr:hover { background: #16213e; }
  .shiny { background: #3d2e00 !important; color: #ffd700; }
  .log-wrap { max-height: 60vh; overflow-y: auto; }
  .ago { color: #666; font-size: 10px; }
  .male { color: #6af; }
  .female { color: #f6a; }
  .game-view { text-align: center; margin-bottom: 16px; }
  .game-view img { width: 720px; height: 480px; image-rendering: pixelated; border: 2px solid #333; border-radius: 8px; background: #000; }
  .game-view .label { font-size: 11px; color: #666; margin-top: 4px; }
</style></head><body>
<h1>Static Encounter Shiny Hunt</h1>
<div class="game-view">
  <img id="gameview" src="/api/frame" alt="Game View" onerror="this.style.opacity=0.3">
  <div class="label">Live Game View</div>
</div>
<div class="stats" id="stats"></div>
<div class="log-wrap"><table><thead><tr>
  <th>#</th><th>Time</th><th>Nature</th><th>Gender</th><th>Stats</th><th>IVs</th>
</tr></thead><tbody id="log"></tbody></table></div>
<script>
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  return Math.floor(s/60) + 'm ago';
}
async function refresh() {
  try {
    const r = await fetch('/api/static/encounters');
    const d = await r.json();
    document.getElementById('stats').innerHTML = [
      ['val', d.encounters, 'label', 'Resets'],
      ['val odds', '1/8192', 'label', 'Standard Odds'],
      ['val', d.rate + '/hr', 'label', 'Rate'],
      ['val', Math.round(d.elapsed/60) + 'm', 'label', 'Elapsed'],
      ['val', d.target, 'label', 'Target'],
    ].map(([vc, v, lc, l]) => '<div class="stat"><div class="'+vc+'">'+v+'</div><div class="'+lc+'">'+l+'</div></div>').join('');

    document.getElementById('log').innerHTML = d.log.map(e => {
      const cls = e.isShiny ? 'shiny' : '';
      const gender = e.gender === 'male' ? '<span class="male">&#9794;</span>'
        : e.gender === 'female' ? '<span class="female">&#9792;</span>' : '?';
      const st = e.stats ? 'HP:'+e.stats.hp+' A:'+e.stats.attack+' D:'+e.stats.defense+' SA:'+e.stats.spAtk+' SD:'+e.stats.spDef+' SP:'+e.stats.speed : '-';
      const ivs = e.ivRanges || '-';
      return '<tr class="'+cls+'"><td>'+e.attempt+'</td><td><span class="ago">'+ago(e.time)+'</span></td><td>'+e.nature+'</td><td>'+gender+'</td><td>'+st+'</td><td style="font-size:10px">'+ivs+'</td></tr>';
    }).join('');
  } catch(e) { console.error(e); }
}
refresh();
setInterval(refresh, 3000);
setInterval(function() {
  var img = document.getElementById('gameview');
  if (img) { img.src = '/api/frame?t=' + Date.now(); img.style.opacity = 1; }
}, 100);
</script></body></html>`;

const WILD_DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Wild Hunt Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, monospace; background: #1a1a2e; color: #e0e0e0; padding: 16px; }
  h1 { color: #ffd700; font-size: 20px; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: #16213e; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .val { font-size: 24px; font-weight: bold; color: #00d4ff; }
  .stat .label { font-size: 11px; color: #888; margin-top: 4px; }
  .odds { color: #ffd700; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #16213e; color: #888; padding: 6px 8px; text-align: left; position: sticky; top: 0; }
  td { padding: 5px 8px; border-bottom: 1px solid #222; }
  tr:hover { background: #16213e; }
  .shiny { background: #3d2e00 !important; color: #ffd700; }
  .log-wrap { max-height: 60vh; overflow-y: auto; }
  .ago { color: #666; font-size: 10px; }
  .timing-slow { color: #ff6b6b; font-weight: bold; }
  .timing-normal { color: #666; }
  .timing-cal { color: #555; font-style: italic; }
  .signal { color: #00ff88; font-weight: bold; }
  .signal-none { color: #333; }
  .game-view { text-align: center; margin-bottom: 16px; }
  .game-view img { width: 720px; height: 480px; image-rendering: pixelated; border: 2px solid #333; border-radius: 8px; background: #000; }
  .game-view .label { font-size: 11px; color: #666; margin-top: 4px; }
</style></head><body>
<h1>Wild Encounter Shiny Hunt — <span id="target" style="color:#ffd700"></span></h1>
<div class="game-view">
  <img id="gameview" src="/api/frame" alt="Game View" onerror="this.style.opacity=0.3">
  <div class="label">Live Game View</div>
</div>
<div class="stats" id="stats"></div>
<div class="log-wrap"><table><thead><tr>
  <th>#</th><th>Time</th><th>Pokemon</th><th>Lv</th><th>Gender</th><th>Delay</th><th>Signal</th>
</tr></thead><tbody id="log"></tbody></table></div>
<script>
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  return Math.floor(s/60) + 'm ago';
}
async function refresh() {
  try {
    const [r, s] = await Promise.all([fetch('/api/wild/encounters'), fetch('/api/status')]);
    const d = await r.json();
    const st = await s.json();
    document.getElementById('target').textContent = st.target ? st.target.toUpperCase() : '';
    document.getElementById('stats').innerHTML = [
      ['val', d.encounters, 'label', 'Encounters'],
      ['val odds', '1/8192', 'label', 'Standard Odds'],
      ['val', d.rate + '/hr', 'label', 'Rate'],
      ['val', Math.round(d.elapsed/60) + 'm', 'label', 'Elapsed'],
    ].map(([vc, v, lc, l]) => '<div class="stat"><div class="'+vc+'">'+v+'</div><div class="'+lc+'">'+l+'</div></div>').join('');

    document.getElementById('log').innerHTML = d.log.map(e => {
      const cls = e.isShiny ? 'shiny' : '';
      const shinyBadge = e.isShiny ? ' <span style="color:#ffd700;font-weight:bold">&#10024; SHINY!</span>' : '';
      const species = (e.species || '???') + shinyBadge;
      const lv = e.level != null ? e.level : '?';
      const gender = e.gender === 'male' ? '<span style="color:#6af">&#9794;</span>'
        : e.gender === 'female' ? '<span style="color:#f6a">&#9792;</span>' : '-';
      const delay = e.textDelayMs ? '<span class="'+(e.textDelayMs > 2500 ? 'timing-slow' : 'timing-normal')+'">'+e.textDelayMs+'ms</span>' : '<span class="timing-cal">-</span>';
      const sigs = e.signals ? '<span class="signal">'+e.signals+'</span>' : '<span class="signal-none">-</span>';
      return '<tr class="'+cls+'"><td>'+e.attempt+'</td><td><span class="ago">'+ago(e.time)+'</span></td><td>'+species+'</td><td>'+lv+'</td><td>'+gender+'</td><td>'+delay+'</td><td>'+sigs+'</td></tr>';
    }).join('');
  } catch(e) { console.error(e); }
}
refresh();
setInterval(refresh, 2000);
// Auto-refresh game view at ~2fps (enough for monitoring, reduces CPU load)
setInterval(function() {
  var img = document.getElementById('gameview');
  if (img) { img.src = '/api/frame?t=' + Date.now(); img.style.opacity = 1; }
}, 500);
</script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Shiny Hunter Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, monospace; background: #1a1a2e; color: #e0e0e0; padding: 16px; }
  h1 { color: #ffd700; font-size: 20px; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: #16213e; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .val { font-size: 24px; font-weight: bold; color: #00d4ff; }
  .stat .label { font-size: 11px; color: #888; margin-top: 4px; }
  .odds { color: #ffd700; }
  .eliminated { color: #ff6b6b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #16213e; color: #888; padding: 6px 8px; text-align: left; position: sticky; top: 0; }
  td { padding: 5px 8px; border-bottom: 1px solid #222; }
  tr:hover { background: #16213e; }
  tr.detail { display: none; }
  tr.detail.open { display: table-row; }
  tr.detail td { padding: 4px 8px 8px 24px; color: #aaa; font-size: 11px; border-bottom: 1px solid #333; background: #111827; }
  .detail-label { color: #666; margin-right: 4px; }
  .detail-val { color: #8cf; }
  .detail-sep { color: #333; margin: 0 8px; }
  .clickable { cursor: pointer; }
  .unique { color: #00ff88; font-weight: bold; }
  .zero { color: #666; }
  .shiny { background: #3d2e00 !important; color: #ffd700; }
  .log-wrap { max-height: 60vh; overflow-y: auto; }
  .ago { color: #666; font-size: 10px; }
  .male { color: #6af; }
  .female { color: #f6a; }
  .legend { font-size: 11px; color: #888; margin-bottom: 8px; }
  .legend span { margin-right: 12px; }
  .delta-pos { color: #ff9966; }
  .delta-neg { color: #66ccff; }
  .delta-zero { color: #00ff88; }
  .game-view { text-align: center; margin-bottom: 16px; }
  .game-view img { width: 720px; height: 480px; image-rendering: pixelated; border: 2px solid #333; border-radius: 8px; background: #000; }
  .game-view .label { font-size: 11px; color: #666; margin-top: 4px; }
</style></head><body>
<h1>Shiny Hunter - Multi-SID Targeting</h1>
<div class="game-view">
  <img id="gameview" src="/api/frame" alt="Game View" onerror="this.style.opacity=0.3">
  <div class="label">Live Game View</div>
</div>
<div class="stats" id="stats"></div>
<div class="legend">
  <span><span class="unique">&#9632;</span> Unique PID</span>
  <span><span class="zero">&#9632;</span> No PID match</span>
  <span><span class="male">&#9794;</span> Male</span>
  <span><span class="female">&#9792;</span> Female</span>
  <span style="color:#8cf">Click row for frame analysis</span>
</div>
<div class="log-wrap"><table><thead><tr>
  <th>#</th><th>Time</th><th>Nature</th><th>Gender</th><th>Stats</th><th>PIDs</th><th>Seed</th><th>SIDs</th><th>OCR</th>
</tr></thead><tbody id="log"></tbody></table></div>
<script>
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  return Math.floor(s/60) + 'm ago';
}
function toggleDetail(id) {
  var el = document.getElementById('detail-'+id);
  if (el) el.classList.toggle('open');
}
async function refresh() {
  try {
    const r = await fetch('/api/rng/encounters');
    const d = await r.json();
    document.getElementById('stats').innerHTML = [
      ['val', d.encounters, 'label', 'Encounters'],
      ['val odds', '1/' + d.multiSIDOdds, 'label', 'Multi-SID Odds'],
      ['val', d.rate + '/hr', 'label', 'Rate'],
      ['val', '1/8192', 'label', 'Standard Odds'],
      ['val', d.activeSIDs, 'label', 'Active SIDs'],
      ['val eliminated', d.eliminatedSIDs, 'label', 'Eliminated'],
      ['val', d.pidObservations, 'label', 'PID Observations'],
      ['val', d.scheduledSeeds || '-', 'label', 'Seeds in Schedule'],
      ['val', d.advanceWindow, 'label', 'Advance Window'],
      ['val', d.advanceHits, 'label', 'Advance Hits'],
      ['val', d.timingOffset + 'ms', 'label', 'Timing Offset'],
    ].map(([vc, v, lc, l]) => '<div class="stat"><div class="'+vc+'">'+v+'</div><div class="'+lc+'">'+l+'</div></div>').join('');

    document.getElementById('log').innerHTML = d.log.map(e => {
      const cls = e.isShiny ? 'shiny' : '';
      const stats = e.stats ? 'HP:'+e.stats.hp+' A:'+e.stats.atk+' D:'+e.stats.def+' SA:'+e.stats.spa+' SD:'+e.stats.spd+' SP:'+e.stats.spe : '-';
      const pid = e.uniquePID ? '<span class="unique">'+e.uniquePID+'</span>'
        : e.pidMatches === 0 ? '<span class="zero">0</span>'
        : e.pidMatches;
      const gender = e.gender === 'male' ? '<span class="male">&#9794;</span>'
        : e.gender === 'female' ? '<span class="female">&#9792;</span>' : '?';
      const ocrMs = e.ocrMs ? e.ocrMs + 'ms' : '-';
      const mainRow = '<tr class="clickable '+cls+'" onclick="toggleDetail('+e.attempt+')"><td>'+e.attempt+'</td><td><span class="ago">'+ago(e.time)+'</span></td><td>'+e.nature+'</td><td>'+gender+'</td><td>'+stats+'</td><td>'+pid+'</td><td>'+e.targetSeed+'</td><td>'+e.targetSIDs+'</td><td>'+ocrMs+'</td></tr>';
      // Frame analysis detail row
      var details = [];
      if (e.detectionDebug) details.push('<span class="detail-label">Detection:</span><span class="detail-val">'+e.detectionDebug+'</span>');
      if (e.timingMs) details.push('<span class="detail-label">Boot timing:</span><span class="detail-val">'+e.timingMs+'ms</span>');
      if (e.seedDelta !== null && e.seedDelta !== undefined) {
        var dc = e.seedDelta === 0 ? 'delta-zero' : e.seedDelta > 0 ? 'delta-pos' : 'delta-neg';
        details.push('<span class="detail-label">Seed delta:</span><span class="'+dc+'">'+(e.seedDelta>=0?'+':'')+e.seedDelta+'</span>');
      }
      if (e.uniquePID) details.push('<span class="detail-label">Identified PID:</span><span class="unique">'+e.uniquePID+'</span>');
      var detailRow = details.length > 0
        ? '<tr class="detail" id="detail-'+e.attempt+'"><td colspan="9">'+details.join('<span class="detail-sep">|</span>')+'</td></tr>'
        : '';
      return mainRow + detailRow;
    }).join('');
  } catch(e) { console.error(e); }
}
refresh();
setInterval(refresh, 5000);
setInterval(function() {
  var img = document.getElementById('gameview');
  if (img) { img.src = '/api/frame?t=' + Date.now(); img.style.opacity = 1; }
}, 100);
</script></body></html>`;

const SUSPEND_DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Suspend RNG Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, monospace; background: #1a1a2e; color: #e0e0e0; padding: 16px; }
  h1 { color: #ffd700; font-size: 20px; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: #16213e; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .val { font-size: 24px; font-weight: bold; color: #00d4ff; }
  .stat .label { font-size: 11px; color: #888; margin-top: 4px; }
  .cal { color: #0f0; }
  .cal.pending { color: #ff0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #16213e; color: #888; padding: 6px 8px; text-align: left; position: sticky; top: 0; }
  td { padding: 5px 8px; border-bottom: 1px solid #222; }
  tr:hover { background: #16213e; }
  .shiny { background: #3d2e00 !important; color: #ffd700; }
  .log-wrap { max-height: 60vh; overflow-y: auto; }
  .game-view { text-align: center; margin-bottom: 16px; }
  .game-view img { width: 720px; height: 480px; image-rendering: pixelated; border: 2px solid #333; border-radius: 8px; background: #000; }
  .game-view .label { font-size: 11px; color: #666; margin-top: 4px; }
</style></head><body>
<h1>Suspend-Point RNG Hunt</h1>
<div class="game-view">
  <img id="gameview" src="/api/frame" alt="Game View" onerror="this.style.opacity=0.3">
  <div class="label">Live Game View</div>
</div>
<div class="stats">
  <div class="stat"><div class="val" id="encounters">-</div><div class="label">Attempts</div></div>
  <div class="stat"><div class="val" id="rate">-</div><div class="label">Per Hour</div></div>
  <div class="stat"><div class="val" id="elapsed">-</div><div class="label">Elapsed</div></div>
  <div class="stat"><div class="val" id="calStatus">-</div><div class="label">Calibration</div></div>
  <div class="stat"><div class="val" id="offset">-</div><div class="label">Frame Offset</div></div>
  <div class="stat"><div class="val" id="seed">-</div><div class="label">Initial Seed</div></div>
</div>
<div class="log-wrap">
  <table><thead><tr>
    <th>#</th><th>Target Frame</th><th>Exp. Advance</th><th>Nature</th><th>Gender</th><th>Possible Advances</th><th>Shiny</th>
  </tr></thead><tbody id="log"></tbody></table>
</div>
<script>
function refresh() {
  fetch('/api/suspend/encounters').then(r => r.json()).then(function(d) {
    document.getElementById('encounters').textContent = d.encounters;
    document.getElementById('rate').textContent = d.rate;
    var m = Math.floor(d.elapsed / 60), s = d.elapsed % 60;
    document.getElementById('elapsed').textContent = m + 'm ' + s + 's';
    var cal = d.calibration || {};
    var calEl = document.getElementById('calStatus');
    calEl.textContent = cal.complete ? 'DONE (' + cal.observations + ' obs)' : cal.observations + '/' + 8;
    calEl.className = 'val cal' + (cal.complete ? '' : ' pending');
    document.getElementById('offset').textContent = cal.frameToAdvanceOffset !== null ? cal.frameToAdvanceOffset : '?';
    document.getElementById('seed').textContent = cal.initialSeed || '?';
    var log = d.log || [];
    var tbody = document.getElementById('log');
    tbody.innerHTML = '';
    log.forEach(function(e) {
      var tr = document.createElement('tr');
      if (e.isShiny) tr.className = 'shiny';
      tr.innerHTML = '<td>' + e.attempt + '</td>' +
        '<td>' + e.targetFrame + '</td>' +
        '<td>' + e.expectedAdvance + '</td>' +
        '<td>' + e.observedNature + '</td>' +
        '<td>' + e.observedGender + '</td>' +
        '<td>' + (e.possibleAdvances || []).slice(0,5).join(', ') + '</td>' +
        '<td>' + (e.isShiny ? 'YES' : '-') + '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function(){});
}
refresh();
setInterval(refresh, 5000);
setInterval(function() {
  var img = document.getElementById('gameview');
  if (img) { img.src = '/api/frame?t=' + Date.now(); img.style.opacity = 1; }
}, 100);
</script></body></html>`;


export function startServer(engine: IHuntEngine, frameSource?: FrameSource, inputController?: InputController): void {
  const app = createServer(engine, frameSource, inputController);
  app.listen(config.server.port, () => {
    logger.info(`Server listening on http://localhost:${config.server.port}`);
  });
}
