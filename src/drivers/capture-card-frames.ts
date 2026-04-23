import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { FrameSource } from '../types';
import { config } from '../config';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

/**
 * Captures frames from a USB capture card via a persistent ffmpeg process piping
 * MJPEG to stdout. Each SOI..EOI-delimited JPEG frame is parsed out in-memory.
 *
 * - `latestJpeg`: most recent complete JPEG buffer — served directly to the
 *   dashboard MJPEG stream (no disk roundtrip = no partial reads)
 * - `latestFrame`: downscaled 240x160 PNG used by shiny-detection pipeline
 * - Emits `frame` event (Buffer) per new complete JPEG so the server can push
 *   to connected dashboards without polling
 */
// If ffmpeg stops producing new JPEG frames for this long, we treat the
// capture pipeline as blacked-out and attempt a full reinit of the ffmpeg
// child process. Two consecutive reinit failures → process.exit(1) for
// PM2 restart. The existing onSignalLost callback (capture card physically
// disconnected) keeps its state-preserving graceful path — this watchdog is
// strictly about a stuck/zombied ffmpeg child.
const CAPTURE_BLACKOUT_MS = 30_000;
const CAPTURE_WATCHDOG_INTERVAL_MS = 5_000;
const CAPTURE_MAX_REINIT_FAILURES = 2;

export class CaptureCardFrames extends EventEmitter implements FrameSource {
  private device = '';
  private tmpPath = '/tmp/shiny-hunter-live.jpg'; // legacy compatibility write
  private ffmpegProcess: ChildProcess | null = null;
  private latestFrame: Buffer | null = null;      // processed 240x160 PNG (for detection)
  private latestJpeg: Buffer | null = null;       // raw JPEG (for dashboard stream)
  private latestFrameTime = 0;
  private lastMjpegFrameTime = 0;                 // wall-clock of most recent JPEG on the MJPEG pipe
  private running = false;
  private dashboardPollTimer: ReturnType<typeof setInterval> | null = null;
  private signalLostTimer: ReturnType<typeof setInterval> | null = null;
  private blackoutWatchdog: ReturnType<typeof setInterval> | null = null;
  private lastFrameSize = 0;
  private staleCount = 0;
  public onSignalLost: (() => void) | null = null;

  // Watchdog metrics surfaced via /api/status.
  private captureBlackoutCount = 0;
  private consecutiveReinitFailures = 0;
  private reinitInProgress = false;

  getCaptureBlackoutCount(): number {
    return this.captureBlackoutCount;
  }

  // MJPEG parser state
  private mjpegBuf: Buffer = Buffer.alloc(0);
  private soiPos = -1; // position of most recent start-of-image marker in mjpegBuf

  getLatestJpeg(): Buffer | null { return this.latestJpeg; }

  async init(): Promise<void> {
    await this.killOrphanedFfmpeg();

    this.device = config.switch.captureDevice;
    if (!this.device) {
      this.device = await this.detectDevice();
    }
    if (!this.device) {
      throw new Error(
        'CAPTURE_DEVICE not set and auto-detect failed. ' +
        'Run `ffmpeg -f avfoundation -list_devices true -i ""` to find your capture card.'
      );
    }
    logger.info(`Capture card frame source initialized: device="${this.device}"`);

    await this.startContinuousCapture();
    await this.waitForFirstFrame();

    const testFrame = await this.captureFrame();
    const isValid = await this.validateGameFrame(testFrame);
    if (!isValid) {
      logger.warn('[Capture] WARNING: Test frame does not look like a GBA game. Check CAPTURE_DEVICE.');
    }
    logger.info('Capture card test frame OK');

    // Background poll: keep dashboard frame cache fresh even when engine isn't capturing
    this.dashboardPollTimer = setInterval(async () => {
      try {
        const raw = await fs.readFile(this.tmpPath);
        if (raw.length < 500) return;
        const buffer = await sharp(raw)
          .trim({ threshold: 20 })
          .resize(240, 160, { fit: 'fill' })
          .png()
          .toBuffer();
        this.latestFrame = buffer;
        this.latestFrameTime = Date.now();
      } catch {}
    }, 500);

    // Signal loss detection: if the tmp file stops changing, capture card lost input
    // (e.g. Switch undocked). Check every 2s, trigger after 8 consecutive stale checks (16s).
    // Threshold must be high enough to survive soft resets (screen goes black for ~5-7s,
    // producing identical JPEG frames with the same file size).
    this.signalLostTimer = setInterval(async () => {
      try {
        const stat = await fs.stat(this.tmpPath);
        if (stat.size === this.lastFrameSize) {
          this.staleCount++;
          if (this.staleCount >= 8) {
            logger.warn('[Capture] Signal lost — capture card has no input (Switch undocked?)');
            this.staleCount = 0;
            if (this.onSignalLost) this.onSignalLost();
          }
        } else {
          this.staleCount = 0;
          this.lastFrameSize = stat.size;
        }
      } catch {}
    }, 2000);

    // Blackout watchdog — fires when the MJPEG pipe has produced no frames
    // for >30s. Distinct from the file-stat signal-lost check: that one trips
    // when the capture hardware loses input (Switch undocked). This one trips
    // when ffmpeg itself is stuck / zombied and no frames are flowing to
    // either the pipe or the disk write.
    this.blackoutWatchdog = setInterval(() => {
      if (!this.running) return;
      if (this.lastMjpegFrameTime === 0) return; // haven't seen a frame yet — init waits handle this
      const age = Date.now() - this.lastMjpegFrameTime;
      if (age < CAPTURE_BLACKOUT_MS) return;
      if (this.reinitInProgress) return;
      this.reinitInProgress = true;
      this.captureBlackoutCount++;
      logger.warn(`[Capture] Blackout: no MJPEG frames for ${Math.round(age / 1000)}s — reinitializing ffmpeg`);
      this.reinitFfmpeg()
        .then(() => {
          this.reinitInProgress = false;
          this.consecutiveReinitFailures = 0;
          logger.info('[Capture] ffmpeg reinit successful');
        })
        .catch((err) => {
          this.reinitInProgress = false;
          this.consecutiveReinitFailures++;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[Capture] ffmpeg reinit failed (${this.consecutiveReinitFailures}/${CAPTURE_MAX_REINIT_FAILURES}): ${msg}`);
          if (this.consecutiveReinitFailures >= CAPTURE_MAX_REINIT_FAILURES) {
            logger.error('[Capture] Max reinit failures reached — exiting for PM2 restart');
            process.exit(1);
          }
        });
    }, CAPTURE_WATCHDOG_INTERVAL_MS);
  }

  private async reinitFfmpeg(): Promise<void> {
    // Kill current ffmpeg, wait for the child to exit, then respawn. The
    // existing startContinuousCapture() already handles an in-flight process
    // by killing it, but we go one step further and wait for the exit event
    // so the OS has released the capture device handle.
    if (this.ffmpegProcess) {
      const proc = this.ffmpegProcess;
      this.ffmpegProcess = null; // prevent the 'exit' listener from auto-respawning
      try {
        proc.kill('SIGKILL');
      } catch { /* already dead */ }
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        // Safety net: don't wait forever if the process is already gone.
        setTimeout(() => resolve(), 2000);
      });
    }

    // Reset MJPEG parser state so we don't try to continue a half-frame.
    this.mjpegBuf = Buffer.alloc(0);
    this.soiPos = -1;
    await new Promise((r) => setTimeout(r, 500));

    await this.startContinuousCapture();
    await this.waitForFirstFrame();
  }

  private async killOrphanedFfmpeg(): Promise<void> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', `ffmpeg.*${this.tmpPath}`]);
      const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const pid of pids) {
        logger.warn(`[Capture] Killing orphaned ffmpeg process (PID ${pid})`);
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      if (pids.length > 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {
      // pgrep exits non-zero when no matches — expected
    }
  }

  private async startContinuousCapture(): Promise<void> {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }

    this.running = true;
    // Single ffmpeg, two outputs: MJPEG piped to stdout (served to dashboard,
    // never partial because parsing is marker-delimited) AND a file write for
    // legacy fallback reads. captureFrame() reads the in-memory latest JPEG.
    this.ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-f', 'avfoundation',
      '-framerate', '30',
      '-video_size', '1920x1080',
      '-i', this.device,
      // Output 1: MJPEG to stdout (dashboard stream)
      '-map', '0:v', '-vf', 'fps=30', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
      // Output 2: single-image file (legacy compatibility)
      '-map', '0:v', '-vf', 'fps=15', '-q:v', '3', '-update', '1', this.tmpPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => this.ingestMjpeg(chunk));

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') && !msg.includes('Last message repeated')) {
        logger.error(`[ffmpeg] ${msg.trim().slice(0, 200)}`);
      }
    });

    this.ffmpegProcess.on('exit', (code) => {
      if (this.running) {
        logger.warn(`[Capture] ffmpeg exited (code ${code}), restarting...`);
        setTimeout(() => this.startContinuousCapture(), 1000);
      }
    });
  }

  /**
   * Parse a chunk of MJPEG stream bytes from ffmpeg's stdout. Frames are
   * delimited by SOI (0xFFD8) and EOI (0xFFD9). Each complete frame is
   * stored as `latestJpeg` and emitted as a `frame` event.
   */
  private ingestMjpeg(chunk: Buffer): void {
    this.mjpegBuf = this.mjpegBuf.length === 0 ? chunk : Buffer.concat([this.mjpegBuf, chunk]);
    // Cap buffer growth: if we haven't found SOI in 2MB, reset to avoid OOM
    if (this.mjpegBuf.length > 2 * 1024 * 1024 && this.soiPos < 0) {
      this.mjpegBuf = Buffer.alloc(0);
      return;
    }
    while (true) {
      if (this.soiPos < 0) {
        this.soiPos = this.findMarker(this.mjpegBuf, 0, 0xD8);
        if (this.soiPos < 0) {
          // drop everything — no SOI in buffer
          this.mjpegBuf = Buffer.alloc(0);
          return;
        }
        // drop bytes before SOI
        if (this.soiPos > 0) {
          this.mjpegBuf = this.mjpegBuf.subarray(this.soiPos);
          this.soiPos = 0;
        }
      }
      // Search for EOI after SOI+2
      const eoi = this.findMarker(this.mjpegBuf, this.soiPos + 2, 0xD9);
      if (eoi < 0) return; // frame still streaming
      const frame = this.mjpegBuf.subarray(this.soiPos, eoi + 2);
      this.latestJpeg = Buffer.from(frame);
      this.lastMjpegFrameTime = Date.now();
      this.emit('frame', this.latestJpeg);
      // advance buffer past this frame
      this.mjpegBuf = this.mjpegBuf.subarray(eoi + 2);
      this.soiPos = -1;
    }
  }

  private findMarker(buf: Buffer, start: number, second: number): number {
    for (let i = start; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i + 1] === second) return i;
    }
    return -1;
  }

  private async waitForFirstFrame(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        const stat = await fs.stat(this.tmpPath);
        if (stat.size > 1000) return;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Timeout waiting for first frame from capture card');
  }

  async captureFrame(): Promise<Buffer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Prefer in-memory JPEG (from MJPEG pipe, never partial). Fall back to
        // disk file only if the pipe hasn't delivered a frame yet.
        const raw = this.latestJpeg ?? await fs.readFile(this.tmpPath);
        if (raw.length < 500) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        const buffer = await sharp(raw)
          .trim({ threshold: 20 })
          .resize(240, 160, { fit: 'fill' })
          .png()
          .toBuffer();
        this.latestFrame = buffer;
        this.latestFrameTime = Date.now();
        return buffer;
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    if (this.latestFrame) return this.latestFrame;
    throw new Error('No frame available from capture card');
  }

  getLatestFrame(): { frame: Buffer; timestamp: number } | null {
    if (!this.latestFrame) return null;
    return { frame: this.latestFrame, timestamp: this.latestFrameTime };
  }

  /**
   * Capture multiple frames at intervals from the continuous stream.
   * Each captureFrame() is ~20ms, so we get true temporal sampling.
   */
  async captureFrameBurst(count: number = 10, durationSec: number = 2): Promise<Buffer[]> {
    const frames: Buffer[] = [];
    const intervalMs = Math.floor((durationSec * 1000) / count);

    for (let i = 0; i < count; i++) {
      try {
        const frame = await this.captureFrame();
        frames.push(frame);
      } catch {}
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    logger.info(`[Capture] Burst: ${frames.length} frames in ${durationSec}s`);
    return frames;
  }

  /**
   * Validate that a captured frame looks like a GBA game (not a webcam).
   */
  private async validateGameFrame(frameBuffer: Buffer): Promise<boolean> {
    const { data, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });
    const uniqueColors = new Set<number>();
    const step = 8;
    for (let y = 0; y < info.height; y += step) {
      for (let x = 0; x < info.width; x += step) {
        const idx = (y * info.width + x) * info.channels;
        const r5 = data[idx] >> 3;
        const g5 = data[idx + 1] >> 3;
        const b5 = data[idx + 2] >> 3;
        uniqueColors.add((r5 << 10) | (g5 << 5) | b5);
      }
    }
    logger.info(`[Capture] Frame validation: ${uniqueColors.size} unique colors (GBA <200, webcam 300+)`);
    return uniqueColors.size < 300;
  }

  async cleanup(): Promise<void> {
    this.running = false;
    if (this.dashboardPollTimer) {
      clearInterval(this.dashboardPollTimer);
      this.dashboardPollTimer = null;
    }
    if (this.signalLostTimer) {
      clearInterval(this.signalLostTimer);
      this.signalLostTimer = null;
    }
    if (this.blackoutWatchdog) {
      clearInterval(this.blackoutWatchdog);
      this.blackoutWatchdog = null;
    }
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
        this.ffmpegProcess.kill('SIGKILL');
      }
      this.ffmpegProcess = null;
    }
    try { await fs.unlink(this.tmpPath); } catch {}
  }

  private async detectDevice(): Promise<string> {
    try {
      const { stderr } = await execFileAsync('ffmpeg', [
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', '',
      ], { timeout: 5000 }).catch((err) => ({ stderr: err.stderr?.toString() || '' })) as { stderr: string };

      const lines = stderr.split('\n');
      const captureKeywords = ['mirabox', 'capture', 'usb video', 'cam link', 'elgato', 'avermedia'];
      const webcamKeywords = ['facetime', 'isight', 'webcam', 'built-in'];

      for (const line of lines) {
        const lower = line.toLowerCase();
        const nameMatch = line.match(/\[\d+\]\s+(.+)/);
        if (!nameMatch) continue;
        const deviceName = nameMatch[1].trim();
        if (webcamKeywords.some(kw => lower.includes(kw))) continue;
        if (captureKeywords.some(kw => lower.includes(kw))) {
          logger.info(`[Capture] Auto-detected: "${deviceName}"`);
          return deviceName;
        }
      }
    } catch {}
    return '';
  }
}
