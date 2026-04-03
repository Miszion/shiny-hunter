/**
 * FrameCounter — Counts GBA visual frames from the USB capture card video feed.
 *
 * The GBA renders at ~59.7275 fps (16.743ms per frame). The MiraBox capture
 * card outputs at 30fps, so we see at most 30 unique frames per second.
 * Frame doubling is common — two consecutive capture-card frames may be the
 * same GBA frame. We detect unique GBA frames by pixel-diffing consecutive
 * captures and only counting transitions where enough pixels changed.
 *
 * For high-accuracy counting beyond what the capture card can sample, we
 * interpolate: if we see N unique frames over a wall-clock interval T,
 * the estimated GBA frames = T / 16.743ms. The visual diff counter is
 * used as a sanity check and for detecting specific events (screen
 * transitions, text boxes, fade-to-black).
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { CaptureCardFrames } from '../drivers/capture-card-frames';
import { logger } from '../logger';
import { config } from '../config';

// GBA timing constants
const GBA_FPS = 59.7275;
const GBA_FRAME_MS = 1000 / GBA_FPS; // ~16.743ms

// Frame diff thresholds
const DIFF_THRESHOLD_PERCENT = 1.5;    // % of pixels that must differ for a "new frame"
const PIXEL_DIFF_THRESHOLD = 20;        // per-channel diff to count as "changed"
const TRANSITION_THRESHOLD_PERCENT = 40; // % change = major visual transition (screen change)
const DARK_THRESHOLD = 30;               // average brightness below this = "dark/black screen"
const TEXT_BOX_REGION = { x: 0, y: 112, width: 240, height: 48 }; // GBA text box region (bottom)

export interface FrameEvent {
  type: 'transition' | 'text_appeared' | 'text_cleared' | 'fade_to_black' | 'fade_from_black';
  frameCount: number;
  timestamp: number;
  diffPercent: number;
}

export interface FrameCounterOptions {
  /** Polling interval for frame capture in ms. Lower = more accurate but more CPU. Default: 8ms */
  pollIntervalMs?: number;
  /** Enable event detection (screen transitions, text boxes). Default: true */
  detectEvents?: boolean;
  /** Directory to save screenshots. Default: 'screenshots' */
  screenshotDir?: string;
}

export class FrameCounter extends EventEmitter {
  private capture: CaptureCardFrames;
  private options: Required<FrameCounterOptions>;

  // Frame counting state
  private frameCount = 0;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTimestamp = 0;

  // Previous frame data for diffing
  private prevFrameRaw: Buffer | null = null;
  private prevFrameWidth = 0;
  private prevFrameHeight = 0;
  private prevFrameChannels = 0;

  // Wall-clock interpolated frame count (more accurate than visual counting)
  private wallClockStartMs = 0;

  // Event detection state
  private lastBrightness = 128;
  private wasBlack = false;
  private lastTextBoxBrightness = 128;
  private hadTextBox = false;

  // Statistics
  private uniqueVisualFrames = 0;
  private totalCaptures = 0;
  private duplicateFrames = 0;

  // Event log
  private events: FrameEvent[] = [];

  constructor(capture: CaptureCardFrames, options?: FrameCounterOptions) {
    super();
    this.capture = capture;
    this.options = {
      pollIntervalMs: options?.pollIntervalMs ?? 8,
      detectEvents: options?.detectEvents ?? true,
      screenshotDir: options?.screenshotDir ?? config.paths.screenshots,
    };
  }

  /**
   * Start counting frames. Resets the counter to 0.
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.frameCount = 0;
    this.uniqueVisualFrames = 0;
    this.totalCaptures = 0;
    this.duplicateFrames = 0;
    this.prevFrameRaw = null;
    this.events = [];
    this.wasBlack = false;
    this.hadTextBox = false;
    this.running = true;
    this.startTimestamp = Date.now();
    this.wallClockStartMs = performance.now();

    logger.info(`[FrameCounter] Started (poll interval: ${this.options.pollIntervalMs}ms)`);

    // Start polling loop
    this.pollTimer = setInterval(() => {
      this.pollFrame().catch((err) => {
        // Silently skip bad frames; capture card can hiccup
      });
    }, this.options.pollIntervalMs);
  }

  /**
   * Stop counting frames.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const elapsed = performance.now() - this.wallClockStartMs;
    logger.info(
      `[FrameCounter] Stopped | ` +
      `Visual: ${this.uniqueVisualFrames} unique / ${this.totalCaptures} captures / ${this.duplicateFrames} dupes | ` +
      `Wall-clock: ${this.getWallClockFrameCount()} estimated GBA frames | ` +
      `Elapsed: ${(elapsed / 1000).toFixed(1)}s | Events: ${this.events.length}`
    );
  }

  /**
   * Get the current frame count. Uses wall-clock interpolation for precision
   * (visual diff count is limited by 30fps capture rate).
   */
  getFrameCount(): number {
    if (!this.running) return this.frameCount;
    return this.getWallClockFrameCount();
  }

  /**
   * Get the raw visual diff frame count (limited by capture card fps).
   * Useful for debugging but less accurate than getFrameCount().
   */
  getVisualFrameCount(): number {
    return this.uniqueVisualFrames;
  }

  /**
   * Reset the frame counter to 0 without stopping.
   */
  resetCounter(): void {
    this.frameCount = 0;
    this.uniqueVisualFrames = 0;
    this.totalCaptures = 0;
    this.duplicateFrames = 0;
    this.wallClockStartMs = performance.now();
    this.events = [];
    logger.info('[FrameCounter] Counter reset to 0');
  }

  /**
   * Wait for a specific number of GBA frames to elapse from the current count.
   * Uses wall-clock timing for sub-frame precision.
   */
  async waitForFrames(n: number): Promise<number> {
    const targetFrame = this.getFrameCount() + n;
    const targetWallMs = this.wallClockStartMs + (targetFrame * GBA_FRAME_MS);

    // Coarse wait: sleep until we're close
    const now = performance.now();
    const remaining = targetWallMs - now;
    if (remaining > 20) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining - 10));
    }

    // Fine wait: busy-spin for the last few ms
    while (performance.now() < targetWallMs) {
      // spin
    }

    const actual = this.getFrameCount();
    return actual;
  }

  /**
   * Wait until a specific absolute frame count is reached.
   */
  async waitUntilFrame(targetFrame: number): Promise<number> {
    const current = this.getFrameCount();
    if (current >= targetFrame) return current;
    return this.waitForFrames(targetFrame - current);
  }

  /**
   * Take a screenshot at the current moment and save to the screenshots directory.
   */
  async takeScreenshot(label: string): Promise<string> {
    const frame = await this.capture.captureFrame();
    const frameCount = this.getFrameCount();
    const filename = `fc-${label}-f${frameCount}-${Date.now()}.png`;
    const filepath = path.join(process.cwd(), this.options.screenshotDir, filename);
    await fs.writeFile(filepath, frame);
    logger.info(`[FrameCounter] Screenshot saved: ${filename} (frame ${frameCount})`);
    return filepath;
  }

  /**
   * Take a screenshot at a specific future frame count.
   */
  async screenshotAtFrame(targetFrame: number, label: string): Promise<string> {
    await this.waitUntilFrame(targetFrame);
    return this.takeScreenshot(label);
  }

  /**
   * Get all detected events.
   */
  getEvents(): FrameEvent[] {
    return [...this.events];
  }

  /**
   * Wait for a specific visual event (e.g., screen transition).
   * Returns the frame count when the event was detected.
   */
  async waitForEvent(
    eventType: FrameEvent['type'],
    timeoutMs: number = 10000,
  ): Promise<FrameEvent | null> {
    const startEvents = this.events.length;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && this.running) {
      // Check if any new event of the desired type appeared
      for (let i = startEvents; i < this.events.length; i++) {
        if (this.events[i].type === eventType) {
          return this.events[i];
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    return null;
  }

  /**
   * Get timing statistics for debugging.
   */
  getStats(): {
    uniqueVisualFrames: number;
    totalCaptures: number;
    duplicateFrames: number;
    wallClockFrames: number;
    elapsedMs: number;
    effectiveCaptureRate: number;
    events: number;
  } {
    const elapsedMs = performance.now() - this.wallClockStartMs;
    return {
      uniqueVisualFrames: this.uniqueVisualFrames,
      totalCaptures: this.totalCaptures,
      duplicateFrames: this.duplicateFrames,
      wallClockFrames: this.getWallClockFrameCount(),
      elapsedMs,
      effectiveCaptureRate: this.totalCaptures > 0
        ? (this.totalCaptures / (elapsedMs / 1000))
        : 0,
      events: this.events.length,
    };
  }

  // === Internal methods ===

  private getWallClockFrameCount(): number {
    const elapsedMs = performance.now() - this.wallClockStartMs;
    return Math.floor(elapsedMs / GBA_FRAME_MS);
  }

  /**
   * Poll a frame from the capture card, diff against previous, and update counts.
   */
  private async pollFrame(): Promise<void> {
    if (!this.running) return;

    const cached = this.capture.getLatestFrame();
    if (!cached) return;

    // Decode the frame to raw pixel data at GBA resolution
    let raw: Buffer;
    let info: sharp.OutputInfo;
    try {
      const result = await sharp(cached.frame)
        .resize(240, 160, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      raw = result.data;
      info = result.info;
    } catch {
      return;
    }

    this.totalCaptures++;

    // First frame — just store it
    if (!this.prevFrameRaw) {
      this.prevFrameRaw = raw;
      this.prevFrameWidth = info.width;
      this.prevFrameHeight = info.height;
      this.prevFrameChannels = info.channels;
      this.uniqueVisualFrames++;
      this.updateBrightness(raw, info);
      return;
    }

    // Diff against previous frame
    const diffResult = this.diffFrames(raw, this.prevFrameRaw, info);

    if (diffResult.changedPercent >= DIFF_THRESHOLD_PERCENT) {
      // This is a new unique GBA frame
      this.uniqueVisualFrames++;
      this.prevFrameRaw = raw;

      // Detect events
      if (this.options.detectEvents) {
        this.detectEvents(raw, info, diffResult.changedPercent);
      }
    } else {
      this.duplicateFrames++;
    }
  }

  /**
   * Compare two raw pixel buffers and return the percentage of changed pixels.
   */
  private diffFrames(
    current: Buffer,
    previous: Buffer,
    info: sharp.OutputInfo,
  ): { changedPercent: number; changedPixels: number; totalPixels: number } {
    const totalPixels = info.width * info.height;
    const channels = info.channels;
    let changedPixels = 0;

    // Sample every 4th pixel for performance (still 15,000 samples at 240x160)
    const step = 4;
    for (let i = 0; i < totalPixels; i += step) {
      const offset = i * channels;
      let diff = 0;
      for (let c = 0; c < channels; c++) {
        diff += Math.abs(current[offset + c] - previous[offset + c]);
      }
      const avgDiff = diff / channels;
      if (avgDiff > PIXEL_DIFF_THRESHOLD) {
        changedPixels++;
      }
    }

    const sampledPixels = Math.ceil(totalPixels / step);
    const changedPercent = (changedPixels / sampledPixels) * 100;

    return { changedPercent, changedPixels, totalPixels: sampledPixels };
  }

  /**
   * Detect visual events: screen transitions, text box appearance, fades.
   */
  private detectEvents(raw: Buffer, info: sharp.OutputInfo, diffPercent: number): void {
    const frameCount = this.getFrameCount();
    const timestamp = Date.now();

    // Major screen transition (>40% pixels changed)
    if (diffPercent >= TRANSITION_THRESHOLD_PERCENT) {
      const event: FrameEvent = {
        type: 'transition',
        frameCount,
        timestamp,
        diffPercent,
      };
      this.events.push(event);
      this.emit('frame-event', event);
      logger.info(`[FrameCounter] Screen transition at frame ${frameCount} (${diffPercent.toFixed(1)}% changed)`);
    }

    // Brightness-based fade detection
    const brightness = this.computeAverageBrightness(raw, info);
    const isBlack = brightness < DARK_THRESHOLD;

    if (isBlack && !this.wasBlack) {
      const event: FrameEvent = {
        type: 'fade_to_black',
        frameCount,
        timestamp,
        diffPercent,
      };
      this.events.push(event);
      this.emit('frame-event', event);
      logger.info(`[FrameCounter] Fade to black at frame ${frameCount}`);
    } else if (!isBlack && this.wasBlack) {
      const event: FrameEvent = {
        type: 'fade_from_black',
        frameCount,
        timestamp,
        diffPercent,
      };
      this.events.push(event);
      this.emit('frame-event', event);
      logger.info(`[FrameCounter] Fade from black at frame ${frameCount}`);
    }
    this.wasBlack = isBlack;
    this.lastBrightness = brightness;

    // Text box detection: analyze the bottom portion of the screen
    const textBrightness = this.computeRegionBrightness(raw, info, TEXT_BOX_REGION);
    // GBA text boxes are typically white/light gray (brightness > 180)
    const hasTextBox = textBrightness > 180;

    if (hasTextBox && !this.hadTextBox) {
      const event: FrameEvent = {
        type: 'text_appeared',
        frameCount,
        timestamp,
        diffPercent,
      };
      this.events.push(event);
      this.emit('frame-event', event);
    } else if (!hasTextBox && this.hadTextBox) {
      const event: FrameEvent = {
        type: 'text_cleared',
        frameCount,
        timestamp,
        diffPercent,
      };
      this.events.push(event);
      this.emit('frame-event', event);
    }
    this.hadTextBox = hasTextBox;
  }

  private updateBrightness(raw: Buffer, info: sharp.OutputInfo): void {
    this.lastBrightness = this.computeAverageBrightness(raw, info);
    this.wasBlack = this.lastBrightness < DARK_THRESHOLD;
  }

  private computeAverageBrightness(raw: Buffer, info: sharp.OutputInfo): number {
    const channels = info.channels;
    const totalPixels = info.width * info.height;
    let sum = 0;
    const step = 8;
    let count = 0;

    for (let i = 0; i < totalPixels; i += step) {
      const offset = i * channels;
      // Luminance approximation: (R + G + B) / 3
      let pixelSum = 0;
      for (let c = 0; c < Math.min(channels, 3); c++) {
        pixelSum += raw[offset + c];
      }
      sum += pixelSum / Math.min(channels, 3);
      count++;
    }

    return count > 0 ? sum / count : 0;
  }

  private computeRegionBrightness(
    raw: Buffer,
    info: sharp.OutputInfo,
    region: { x: number; y: number; width: number; height: number },
  ): number {
    const channels = info.channels;
    let sum = 0;
    let count = 0;
    const step = 4;

    for (let y = region.y; y < region.y + region.height && y < info.height; y += step) {
      for (let x = region.x; x < region.x + region.width && x < info.width; x += step) {
        const offset = (y * info.width + x) * channels;
        let pixelSum = 0;
        for (let c = 0; c < Math.min(channels, 3); c++) {
          pixelSum += raw[offset + c];
        }
        sum += pixelSum / Math.min(channels, 3);
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }
}

// Export constants for use by other modules
export { GBA_FPS, GBA_FRAME_MS };
