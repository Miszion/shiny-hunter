import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { FrameSource } from '../types';
import { config } from '../config';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

/**
 * Captures frames from a USB capture card using a persistent ffmpeg process.
 * ffmpeg runs continuously at 10fps, writing to a single file with -update 1.
 * captureFrame() reads the latest file (~20ms vs ~1750ms with per-invocation ffmpeg).
 */
export class CaptureCardFrames implements FrameSource {
  private device = '';
  private tmpPath = '/tmp/shiny-hunter-live.jpg';
  private ffmpegProcess: ChildProcess | null = null;
  private latestFrame: Buffer | null = null;
  private latestFrameTime = 0;
  private running = false;
  private dashboardPollTimer: ReturnType<typeof setInterval> | null = null;
  private signalLostTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameSize = 0;
  private staleCount = 0;
  public onSignalLost: (() => void) | null = null;

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
    this.ffmpegProcess = spawn('ffmpeg', [
      '-y',
      '-f', 'avfoundation',
      '-framerate', '30',
      '-video_size', '1920x1080',
      '-i', this.device,
      '-vf', 'fps=30',
      '-q:v', '3',
      '-update', '1',
      this.tmpPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

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
        const raw = await fs.readFile(this.tmpPath);
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
