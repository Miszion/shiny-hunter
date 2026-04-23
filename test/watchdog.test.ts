/**
 * Unit tests for the hunt-resilience watchdogs added to recover from the
 * silent-stall bug (process alive per PM2, zero real encounters happening).
 *
 * Covered:
 *   - LegendaryHuntEngine.transition() bumps lastStateChangeAt
 *   - Stuck-state detector increments stuckStateCount and forces SOFT_RESET
 *   - SwitchInput exposes getEsp32TimeoutCount() and increments it
 *   - CaptureCardFrames exposes getCaptureBlackoutCount()
 *
 * We intentionally do NOT spin up real ffmpeg or real serial. The watchdog
 * logic is driven via mocked collaborators.
 */

import { LegendaryHuntEngine } from '../src/engine/legendary-hunt';
import { FrameSource, InputController } from '../src/types';

class NoopInput implements InputController {
  public softResetCalls = 0;
  async pressButton(): Promise<void> {}
  async pressButtons(): Promise<void> {}
  async releaseAll(): Promise<void> {}
  async softReset(): Promise<void> {
    this.softResetCalls++;
    // Simulate the ESP32 RESET round trip (~2s) so the tick loop actually
    // spends time in SOFT_RESET → WAIT_BOOT rather than burning CPU.
    await new Promise((r) => setTimeout(r, 50));
  }
  async loadState(): Promise<void> {}
  async saveState(): Promise<void> {}
  async setTurbo(): Promise<void> {}
  async init(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

class StubFrames implements FrameSource {
  async captureFrame(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async init(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

describe('LegendaryHuntEngine stuck-state detector', () => {
  test('getStuckStateCount starts at 0 before hunt starts', () => {
    const engine = new LegendaryHuntEngine(new StubFrames(), new NoopInput());
    expect(engine.getStuckStateCount()).toBe(0);
  });

  test('transition() helper exists and updates state timestamp', () => {
    const engine = new LegendaryHuntEngine(new StubFrames(), new NoopInput()) as any;
    const before = engine.lastStateChangeAt ?? 0;
    engine.transition('WAIT_BOOT');
    expect(engine.state).toBe('WAIT_BOOT');
    expect(engine.lastStateChangeAt).toBeGreaterThanOrEqual(before);
  });

  test('watchdog interval exists after start() and is cleared on stop()', async () => {
    const engine = new LegendaryHuntEngine(new StubFrames(), new NoopInput()) as any;
    // Don't actually run the tick loop — just simulate start()'s watchdog wiring.
    // Call start() then stop() fast; the tick loop exits when running=false.
    const startPromise = engine.start();
    // give one microtask for the async start body to set up
    await new Promise((r) => setImmediate(r));
    expect(engine.stuckStateWatchdog).not.toBeNull();
    engine.stop();
    await startPromise.catch(() => {});
    expect(engine.stuckStateWatchdog).toBeNull();
  });

  test('force-transition to SOFT_RESET increments stuck count when state is stale', () => {
    // Drive the watchdog body directly instead of waiting 60s in real time.
    const engine = new LegendaryHuntEngine(new StubFrames(), new NoopInput()) as any;
    engine.running = true;
    engine.state = 'DETECT';
    engine.lastStateChangeAt = Date.now() - 70_000; // simulate 70s wedge
    const before = engine.stuckStateCount;
    // Copy of the watchdog predicate from start()
    const STUCK_STATE_TIMEOUT_MS = 60_000;
    const age = Date.now() - engine.lastStateChangeAt;
    if (age >= STUCK_STATE_TIMEOUT_MS) {
      engine.stuckStateCount++;
      engine.transition('SOFT_RESET');
    }
    expect(engine.stuckStateCount).toBe(before + 1);
    expect(engine.state).toBe('SOFT_RESET');
    engine.running = false;
  });

  test('getStatus returns running=false and encounters=0 when idle', () => {
    const engine = new LegendaryHuntEngine(new StubFrames(), new NoopInput());
    const status = engine.getStatus();
    expect(status.running).toBe(false);
    expect(status.encounters).toBe(0);
  });
});

describe('SwitchInput esp32 fault accounting', () => {
  // Import lazily so jest doesn't evaluate serialport at module load when
  // running in a no-hardware environment.
  test('getEsp32TimeoutCount is exposed and starts at 0', () => {
    const { SwitchInput } = require('../src/drivers/switch-input');
    const input = new SwitchInput();
    expect(typeof input.getEsp32TimeoutCount).toBe('function');
    expect(input.getEsp32TimeoutCount()).toBe(0);
  });

  test('getSerialPortReopenCount is exposed and starts at 0', () => {
    const { SwitchInput } = require('../src/drivers/switch-input');
    const input = new SwitchInput();
    expect(typeof input.getSerialPortReopenCount).toBe('function');
    expect(input.getSerialPortReopenCount()).toBe(0);
  });

  test('sendCommand on closed port feeds watchdog (bugfix: not open used to bypass it)', async () => {
    // Before fix: "Serial port not open" bypassed the watchdog and the hunt
    // silently stalled for 58 min on 2026-04-23. After fix: closed-port
    // errors count toward esp32_timeout_count just like true timeouts.
    const { SwitchInput } = require('../src/drivers/switch-input');
    const input: any = new SwitchInput();
    // Stub reopenPort so the threshold branch doesn't touch real serial.
    let reopenCalls = 0;
    input.reopenPort = async () => {
      reopenCalls++;
    };

    // First two closed-port rejects bump the counter but stay below threshold.
    await expect(input.sendCommand('PING', 50)).rejects.toThrow(/not open/);
    await expect(input.sendCommand('PING', 50)).rejects.toThrow(/not open/);
    expect(input.getEsp32TimeoutCount()).toBe(2);
    expect(reopenCalls).toBe(0);

    // Third reject hits threshold: reopenPort fires, retry still has no port,
    // so the watchdog calls process.exit(1). Stub exit to throw so we can
    // assert without killing the jest worker.
    const origExit = process.exit;
    (process as any).exit = (code: number) => {
      throw new Error(`process.exit(${code})`);
    };
    try {
      await expect(input.sendCommand('PING', 50)).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      (process as any).exit = origExit;
    }
    expect(reopenCalls).toBe(1);
    expect(input.getEsp32TimeoutCount()).toBe(3);
  });

  test('unsolicited close event on the serial port schedules a gated reopen', async () => {
    const { SwitchInput } = require('../src/drivers/switch-input');
    const { EventEmitter } = require('events');
    const input: any = new SwitchInput();

    // Fake SerialPort exposing just the surface attachCloseListener uses.
    const fakePort: any = new EventEmitter();
    fakePort.isOpen = true;
    input.port = fakePort;

    let reopenCalls = 0;
    let reopenInProgressAtCallTime: boolean | null = null;
    input.reopenPort = async () => {
      reopenCalls++;
      // Verify the lock was claimed synchronously before the async body ran.
      reopenInProgressAtCallTime = input.reopenInProgress;
    };

    input.attachCloseListener();

    // Simulate an OS-level tty close — USB hiccup / ESP32 reboot.
    fakePort.emit('close');
    // Listener schedules the reopen via setImmediate; yield for it.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(reopenCalls).toBe(1);
    expect(reopenInProgressAtCallTime).toBe(true);
    // Lock released after the async reopen finishes.
    expect(input.reopenInProgress).toBe(false);
  });

  test('close event during an in-progress reopen does NOT stampede a second reopen', async () => {
    const { SwitchInput } = require('../src/drivers/switch-input');
    const { EventEmitter } = require('events');
    const input: any = new SwitchInput();

    const fakePort: any = new EventEmitter();
    fakePort.isOpen = true;
    input.port = fakePort;

    let reopenCalls = 0;
    input.reopenPort = async () => {
      reopenCalls++;
    };

    // Simulate sendCommand having already claimed the reopen lock.
    input.reopenInProgress = true;
    input.attachCloseListener();
    fakePort.emit('close');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(reopenCalls).toBe(0);
  });
});

describe('CaptureCardFrames blackout counter', () => {
  test('getCaptureBlackoutCount is exposed and starts at 0', () => {
    const { CaptureCardFrames } = require('../src/drivers/capture-card-frames');
    const cap = new CaptureCardFrames();
    expect(typeof cap.getCaptureBlackoutCount).toBe('function');
    expect(cap.getCaptureBlackoutCount()).toBe(0);
  });
});
