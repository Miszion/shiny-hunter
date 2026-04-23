import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { InputController, GBAButton } from '../types';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Sends commands to ESP32-S3 Switch controller emulator over serial (UART).
 * The ESP32 translates serial commands into USB HID reports for the Switch.
 *
 * Protocol (newline-delimited):
 *   PRESS <button> [duration_ms]  — press and release after duration
 *   HOLD <button>                 — hold until RELEASE
 *   RELEASE <button>              — release held button
 *   RELEASE_ALL                   — release everything
 *   RESET                         — A+B+X+Y for 1s (Switch soft reset)
 *   PING                          — returns PONG
 *   STATUS                        — returns HID_READY=true/false
 *
 * Responses: "OK", "PONG", "ERR ...", "HID_READY=...", "STATE:..."
 */

// Map GBA buttons to ESP32 firmware button names
const BUTTON_MAP: Record<GBAButton, string> = {
  A: 'A',
  B: 'B',
  START: 'PLUS',
  SELECT: 'MINUS',
  UP: 'UP',
  DOWN: 'DOWN',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  L: 'L',
  R: 'R',
};

// After this many consecutive serial faults (command timeouts OR closed-port
// errors) we close the serial port, reopen it, and retry the failing command
// once. If the retry also fails we exit(1) so PM2 restarts the process
// cleanly — a wedged ESP32 will otherwise silently stall the hunt (seen
// 2026-04-22 10:32-10:37 CDT: 58 RESET timeouts in a row; and 2026-04-23
// 15:26 CDT: 58 min stall with "not open" errors bypassing the watchdog).
const ESP32_TIMEOUTS_BEFORE_REOPEN = 3;

// Errors from sendCommandRaw that indicate the serial link is faulty and
// should feed the reopen/retry/exit ladder. Closed-port and mid-reopen
// races are additive to the original "timed out" condition.
function isSerialFaultError(msg: string): boolean {
  return (
    msg.includes('timed out') ||
    msg.includes('not open') ||
    msg.includes('Serial port reopening')
  );
}

export class SwitchInput implements InputController {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private responseQueue: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private hidReady = false;

  // Watchdog state — consecutive serial faults (command timeouts OR closed-port
  // errors) since last successful response. Resets to 0 on any successful
  // response. Exposed via getEsp32TimeoutCount() for /api/status telemetry;
  // name kept for backwards compatibility even though it now covers all
  // serial faults, not just timeouts.
  private consecutiveTimeouts = 0;
  private totalTimeouts = 0;
  private reopenInProgress = false;

  // Lifetime count of successful port reopens during this process, surfaced
  // via /api/status as serial_port_reopens so the dashboard can see when
  // auto-recovery fires without grepping logs.
  private totalReopens = 0;

  getEsp32TimeoutCount(): number {
    return this.totalTimeouts;
  }

  getSerialPortReopenCount(): number {
    return this.totalReopens;
  }

  async init(): Promise<void> {
    const serialPath = config.switch.serialPort;
    if (!serialPath) {
      throw new Error('SWITCH_SERIAL_PORT not set. Set it to the ESP32 COM port path (e.g. /dev/cu.usbmodem...)');
    }
    await this.openPort(serialPath);

    // Wait for ESP32 to be ready
    await this.wait(500);

    // Verify connection
    const pong = await this.sendCommandRaw('PING');
    if (pong !== 'PONG') {
      throw new Error(`ESP32 PING failed, got: ${pong}`);
    }

    // Check HID status
    const status = await this.sendCommandRaw('STATUS');
    this.hidReady = status.includes('true');
    logger.info(`Switch controller initialized (HID ready: ${this.hidReady})`);
  }

  private async openPort(serialPath: string): Promise<void> {
    logger.info(`Opening serial port: ${serialPath} @ ${config.switch.serialBaud} baud`);

    this.port = new SerialPort({
      path: serialPath,
      baudRate: config.switch.serialBaud,
      autoOpen: false,
    });

    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.parser.on('data', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Async state notifications from ESP32
      if (trimmed.startsWith('STATE:')) {
        this.hidReady = trimmed === 'STATE:HID_READY';
        logger.info(`Switch HID state: ${trimmed}`);
        return;
      }

      if (trimmed === 'READY') {
        logger.info('ESP32 controller ready');
        return;
      }

      // Response to a command
      const pending = this.responseQueue.shift();
      if (pending) {
        clearTimeout(pending.timeout);
        // Any well-formed response (even ERR) proves the serial link is alive,
        // so reset the consecutive-timeout watchdog counter.
        this.consecutiveTimeouts = 0;
        if (trimmed.startsWith('ERR')) {
          pending.reject(new Error(`ESP32: ${trimmed}`));
        } else {
          pending.resolve(trimmed);
        }
      } else {
        logger.debug(`ESP32 unsolicited: ${trimmed}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => {
        if (err) {
          reject(new Error(`Failed to open serial port: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    this.attachCloseListener();
  }

  // Wire a 'close' event listener on this.port so an OS-level tty close
  // (USB hiccup, ESP32 reboot, macOS serial driver flap) does not silently
  // strand us with isOpen=false forever. Gated by reopenInProgress so our
  // own explicit close inside reopenPort() does not cause a reopen storm
  // or stampede concurrent sendCommand callers. Extracted from openPort()
  // so tests can drive it against a fake port without real serial.
  private attachCloseListener(): void {
    if (!this.port) return;
    this.port.on('close', () => {
      if (this.reopenInProgress) {
        logger.debug('[ESP32] Serial port close event (reopen in progress — expected)');
        return;
      }
      // Claim the reopen lock synchronously so concurrent sendCommand
      // callers back off instead of racing us.
      this.reopenInProgress = true;
      logger.warn('[ESP32] Unsolicited serial port close — scheduling proactive reopen');
      setImmediate(async () => {
        try {
          await this.reopenPort();
          logger.info('[ESP32] Proactive reopen after unsolicited close succeeded');
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logger.error(
            `[ESP32] Proactive reopen after unsolicited close failed: ${m} — exiting for PM2 restart`,
          );
          process.exit(1);
        } finally {
          this.reopenInProgress = false;
        }
      });
    });
  }

  // Issue a single command with a timeout. Does not trigger any recovery on
  // timeout — used during init() (before the watchdog is meaningful) and as
  // the primitive beneath sendCommand().
  private sendCommandRaw(cmd: string, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        reject(new Error('Serial port not open'));
        return;
      }

      const timeout = setTimeout(() => {
        const idx = this.responseQueue.findIndex((q) => q.timeout === timeout);
        if (idx >= 0) this.responseQueue.splice(idx, 1);
        reject(new Error(`ESP32 command timed out: ${cmd}`));
      }, timeoutMs);

      this.responseQueue.push({ resolve, reject, timeout });
      this.port.write(cmd + '\n');
    });
  }

  // Issue a command with watchdog-backed auto-recovery.
  // Flow:
  //   1. Try the command.
  //   2. On success: reset counter, return.
  //   3. On serial fault (timeout OR closed-port / reopening race): increment
  //      counter.
  //      - If counter < threshold, rethrow and let the caller handle it.
  //      - If counter >= threshold, reopen the port and retry ONCE.
  //        If the retry also fails, process.exit(1) for PM2 to restart.
  // The "not open" branch was previously unfiltered — it bypassed the
  // watchdog entirely and caused a 58-min silent stall on 2026-04-23.
  private async sendCommand(cmd: string, timeoutMs = 3000): Promise<string> {
    try {
      const out = await this.sendCommandRaw(cmd, timeoutMs);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isSerialFaultError(msg)) throw err;

      this.consecutiveTimeouts++;
      this.totalTimeouts++;

      if (this.consecutiveTimeouts < ESP32_TIMEOUTS_BEFORE_REOPEN) {
        throw err;
      }

      if (this.reopenInProgress) {
        // Another caller is already reopening — fail fast.
        throw err;
      }

      logger.warn(
        `[ESP32] ${this.consecutiveTimeouts} consecutive serial faults (${msg}) — reopening serial port and retrying "${cmd}" once`,
      );
      this.reopenInProgress = true;
      try {
        await this.reopenPort();
      } catch (reopenErr) {
        this.reopenInProgress = false;
        const rmsg = reopenErr instanceof Error ? reopenErr.message : String(reopenErr);
        logger.error(`[ESP32] Reopen failed: ${rmsg} — exiting so PM2 restarts us`);
        process.exit(1);
      }
      this.reopenInProgress = false;

      // One retry after a successful reopen. If that also times out, exit so
      // PM2 can restart the whole process cleanly.
      try {
        const out = await this.sendCommandRaw(cmd, timeoutMs);
        this.consecutiveTimeouts = 0;
        logger.info(`[ESP32] Recovered after reopen — "${cmd}" succeeded on retry`);
        return out;
      } catch (retryErr) {
        const rmsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error(`[ESP32] Retry after reopen failed: ${rmsg} — exiting for PM2 restart`);
        process.exit(1);
      }
    }
  }

  private async reopenPort(): Promise<void> {
    const serialPath = config.switch.serialPort;

    // Drain pending responses before closing — they will never land.
    for (const pending of this.responseQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Serial port reopening'));
    }
    this.responseQueue = [];

    if (this.port) {
      try {
        if (this.port.isOpen) {
          await new Promise<void>((resolve) => {
            this.port!.close(() => resolve());
          });
        }
      } catch { /* ignore close errors */ }
      this.port = null;
      this.parser = null;
    }

    // Brief pause so the OS releases the tty handle before we grab it again.
    await this.wait(250);
    await this.openPort(serialPath);
    await this.wait(500);
    this.totalReopens++;
  }

  async pressButton(button: GBAButton, holdMs = 100): Promise<void> {
    const mapped = BUTTON_MAP[button];
    if (!mapped) throw new Error(`Unknown button: ${button}`);
    await this.sendCommand(`PRESS ${mapped} ${holdMs}`);
  }

  async pressButtons(buttons: GBAButton[], holdMs = 100): Promise<void> {
    // ESP32 firmware doesn't have a multi-button PRESS command,
    // so we HOLD all buttons, wait, then RELEASE_ALL
    for (const btn of buttons) {
      const mapped = BUTTON_MAP[btn];
      if (!mapped) throw new Error(`Unknown button: ${btn}`);
      await this.sendCommand(`HOLD ${mapped}`);
    }
    await this.wait(holdMs);
    await this.sendCommand('RELEASE_ALL');
  }

  async releaseAll(): Promise<void> {
    await this.sendCommand('RELEASE_ALL');
  }

  async softReset(): Promise<void> {
    // Switch soft reset: A+B+X+Y held for 1 second (handled by ESP32 RESET command)
    await this.sendCommand('RESET', 5000);
    logger.info('Switch soft reset sent');
    // Wait after reset — Switch needs time to process the reset
    await this.wait(2000);
  }

  async loadState(_slot: number): Promise<void> {
    // Not available on real hardware — no-op with warning
    logger.warn('loadState not available on Switch hardware');
  }

  async saveState(_slot: number): Promise<void> {
    // Not available on real hardware — no-op with warning
    logger.warn('saveState not available on Switch hardware');
  }

  async setTurbo(_enabled: boolean): Promise<void> {
    // Not available on real hardware — no-op
    logger.warn('Turbo mode not available on Switch hardware');
  }

  logEncounter(encounter: number, isShiny: boolean, pokemon: string, details?: string): void {
    const level = isShiny ? 'SHINY' : 'INFO';
    const msg = isShiny
      ? `*** SHINY ${pokemon.toUpperCase()} FOUND *** Encounter #${encounter}`
      : `Encounter #${encounter} -- ${pokemon} (normal)`;
    const detailStr = details ? ` | ${details}` : '';
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `${timestamp} [${level}] [ENCOUNTER] ${msg}${detailStr}\n`;
    const fs = require('fs');
    try {
      fs.appendFileSync(require('path').join(process.cwd(), 'logs/switch-hunt.log'), line);
    } catch { /* ignore */ }
  }

  async cleanup(): Promise<void> {
    // Drain pending commands
    for (const pending of this.responseQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Cleanup — port closing'));
    }
    this.responseQueue = [];

    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => {
        this.port!.close(() => resolve());
      });
    }
    this.port = null;
    this.parser = null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
