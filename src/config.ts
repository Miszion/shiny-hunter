import dotenv from 'dotenv';
dotenv.config();

export const config = {
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },
  mgba: {
    host: process.env.MGBA_HOST || '127.0.0.1',
    port: parseInt(process.env.MGBA_PORT || '8888', 10),
  },
  hunt: {
    target: process.env.TARGET_POKEMON || 'charmander',
    game: process.env.GAME || 'fire-red',
    saveStateSlot: parseInt(process.env.SAVE_STATE_SLOT || '1', 10),
    turboEnabled: process.env.TURBO_ENABLED !== 'false',
    milestoneInterval: 500,
    // Hunt mode: 'reset' | 'rng' (emulator memory reads) | 'switch-rng' (blind timing, no memory reads) | 'suspend-rng' (suspend point + frame counting)
    mode: (process.env.HUNT_MODE || 'reset') as 'reset' | 'rng' | 'switch-rng' | 'suspend-rng',
    // Hunt type: 'starter' | 'wild' | 'static' | 'casino'
    // starter: pick starter from pokeball, check summary
    // wild: walk in grass/water, detect shiny sparkle in battle
    // static: redeem fossil/gift, check summary (TODO)
    // casino: redeem casino prize, check summary (TODO)
    huntType: (process.env.HUNT_TYPE || 'starter') as 'starter' | 'wild' | 'static' | 'casino',
    // Target nature for RNG mode (optional, e.g. 'adamant', 'jolly')
    targetNature: process.env.TARGET_NATURE || '',
  },
  // Environment: 'emulator' (mGBA) or 'switch' (real Switch hardware)
  env: (process.env.HUNT_ENV || 'emulator') as 'emulator' | 'switch',
  switch: {
    serialPort: process.env.SWITCH_SERIAL_PORT || '',
    serialBaud: parseInt(process.env.SWITCH_BAUD || '115200', 10),
    captureDevice: process.env.CAPTURE_DEVICE || '',
  },
  rng: {
    starterAdvanceCount: parseInt(process.env.RNG_ADVANCE_COUNT || '1150', 10),
    starterAdvanceWindow: parseInt(process.env.RNG_ADVANCE_WINDOW || '100', 10),
    biosOffsetMs: parseInt(process.env.RNG_BIOS_OFFSET || '4500', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3002', 10),
  },
  paths: {
    db: 'data/shiny-hunter.db',
    screenshots: 'screenshots',
    tmpFrame: '/tmp/shiny-hunter-frame.png',
  },
};
