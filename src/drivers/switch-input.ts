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
 *   RESET                         — A+B+X+Y for 1s (NSO soft reset)
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

export class SwitchInput implements InputController {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private responseQueue: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private hidReady = false;

  async init(): Promise<void> {
    const serialPath = config.switch.serialPort;
    if (!serialPath) {
      throw new Error('SWITCH_SERIAL_PORT not set. Set it to the ESP32 COM port path (e.g. /dev/cu.usbmodem...)');
    }

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

    // Wait for ESP32 to be ready
    await this.wait(500);

    // Verify connection
    const pong = await this.sendCommand('PING');
    if (pong !== 'PONG') {
      throw new Error(`ESP32 PING failed, got: ${pong}`);
    }

    // Check HID status
    const status = await this.sendCommand('STATUS');
    this.hidReady = status.includes('true');
    logger.info(`Switch controller initialized (HID ready: ${this.hidReady})`);
  }

  private sendCommand(cmd: string, timeoutMs = 3000): Promise<string> {
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
    // NSO soft reset: A+B+X+Y held for 1 second (handled by ESP32 RESET command)
    await this.sendCommand('RESET', 5000);
    logger.info('NSO soft reset sent');
    // Wait after reset — NSO needs time to process the reset
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
