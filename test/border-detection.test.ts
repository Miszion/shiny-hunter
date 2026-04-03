import sharp from 'sharp';
import { detectShiny } from '../src/detection/shiny-detector';

/**
 * Tests for summary screen border-based shiny detection.
 *
 * In FRLG, the summary screen has a colored UI border:
 * - Normal Pokemon: purple/lavender border (hue ~270°)
 * - Shiny Pokemon: teal/cyan border (hue ~177°)
 *
 * The detector samples specific pixel coordinates in the border region
 * and classifies based on whether teal or purple dominates.
 *
 * These tests use synthetic 240x160 images with controlled pixel colors
 * to verify detection logic without needing real screenshots.
 */

// Summary screen layout (240x160):
// - Page indicator at (120, 5): always teal
// - Border/panel header at (10,20), (75,20), (40,17), (60,17): purple or teal
// - Right side (200,60), (220,80), (200,100): light cream/white
// - (10,30): colored UI element

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/**
 * Create a synthetic 240x160 summary screen image.
 * @param borderHue - HSL hue for the border color (270 = purple, 177 = teal)
 * @param borderSat - HSL saturation for the border (0-1)
 * @param borderLight - HSL lightness for the border (0-1)
 */
async function createSyntheticSummaryScreen(
  borderHue: number,
  borderSat: number = 0.5,
  borderLight: number = 0.55,
): Promise<Buffer> {
  const width = 240;
  const height = 160;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);

  // Fill background with cream/light color (typical summary right side)
  const cream: [number, number, number] = [230, 210, 180];
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = cream[0];
    buf[i * 3 + 1] = cream[1];
    buf[i * 3 + 2] = cream[2];
  }

  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = (y * width + x) * channels;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
    }
  };

  // Set page indicator (120, 5) — always teal
  const teal = hslToRgb(180, 0.6, 0.55);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      setPixel(120 + dx, 5 + dy, teal[0], teal[1], teal[2]);
    }
  }

  // Set border pixels — the key detection points
  const borderRgb = hslToRgb(borderHue, borderSat, borderLight);
  const borderPoints = [
    { x: 10, y: 20 },
    { x: 75, y: 20 },
    { x: 10, y: 30 },
    { x: 40, y: 17 },
    { x: 60, y: 17 },
  ];
  for (const pt of borderPoints) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        setPixel(pt.x + dx, pt.y + dy, borderRgb[0], borderRgb[1], borderRgb[2]);
      }
    }
  }

  // Right side stays cream (already set as background)

  return sharp(buf, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Create a non-summary screen (solid dark color).
 */
async function createNonSummaryScreen(): Promise<Buffer> {
  const width = 240;
  const height = 160;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels, 30); // dark gray
  return sharp(buf, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Create a black screen (no signal / transition).
 */
async function createBlackScreen(): Promise<Buffer> {
  const width = 240;
  const height = 160;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels, 0);
  return sharp(buf, { raw: { width, height, channels } }).png().toBuffer();
}

describe('Border-based shiny detection (summary screen)', () => {
  describe('Normal Pokemon (purple border)', () => {
    test('strong purple border → not shiny', async () => {
      // Purple: hue 270°, sat 23%, light 58% (real calibrated values)
      const frame = await createSyntheticSummaryScreen(270, 0.23, 0.58);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toContain('border=normal(purple)');
      expect(result.debugInfo).not.toBe('not on summary screen');
    });

    test('lavender border (hue 280°) → not shiny', async () => {
      const frame = await createSyntheticSummaryScreen(280, 0.30, 0.55);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toContain('border=normal(purple)');
    });

    test('deep purple border (hue 260°) → not shiny', async () => {
      const frame = await createSyntheticSummaryScreen(260, 0.25, 0.50);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toContain('border=normal(purple)');
    });
  });

  describe('Shiny Pokemon (teal border)', () => {
    test('strong teal border (hue 177°) → shiny', async () => {
      // Teal: hue 177°, sat 74%, light 65% (real calibrated values)
      const frame = await createSyntheticSummaryScreen(177, 0.74, 0.65);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(true);
      expect(result.debugInfo).toContain('border=SHINY(teal)');
      expect(result.debugInfo).not.toBe('not on summary screen');
    });

    test('cyan border (hue 190°) → shiny', async () => {
      const frame = await createSyntheticSummaryScreen(190, 0.60, 0.55);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(true);
      expect(result.debugInfo).toContain('border=SHINY(teal)');
    });

    test('blue-teal border (hue 165°) → shiny', async () => {
      const frame = await createSyntheticSummaryScreen(165, 0.50, 0.55);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(true);
      expect(result.debugInfo).toContain('border=SHINY(teal)');
    });
  });

  describe('Pokemon-agnostic (border works for any Pokemon)', () => {
    const testCases = ['dratini', 'lapras', 'aerodactyl', 'kabuto', 'omanyte'];

    test.each(testCases)('teal border → shiny for %s', async (pokemon) => {
      const frame = await createSyntheticSummaryScreen(177, 0.74, 0.65);
      const result = await detectShiny(frame, pokemon, 'leaf-green');

      expect(result.isShiny).toBe(true);
      expect(result.debugInfo).toContain('border=SHINY(teal)');
    });

    test.each(testCases)('purple border → not shiny for %s', async (pokemon) => {
      const frame = await createSyntheticSummaryScreen(270, 0.23, 0.58);
      const result = await detectShiny(frame, pokemon, 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toContain('border=normal(purple)');
    });
  });

  describe('Non-summary screens', () => {
    test('dark screen → not on summary screen', async () => {
      const frame = await createNonSummaryScreen();
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toBe('not on summary screen');
    });

    test('black screen → not on summary screen', async () => {
      const frame = await createBlackScreen();
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(false);
      expect(result.debugInfo).toBe('not on summary screen');
    });
  });

  describe('Game compatibility', () => {
    test('fire-red: teal border → shiny', async () => {
      const frame = await createSyntheticSummaryScreen(177, 0.74, 0.65);
      const result = await detectShiny(frame, 'dratini', 'fire-red');

      expect(result.isShiny).toBe(true);
    });

    test('leaf-green: teal border → shiny', async () => {
      const frame = await createSyntheticSummaryScreen(177, 0.74, 0.65);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.isShiny).toBe(true);
    });
  });

  describe('Confidence scoring', () => {
    test('strong teal has high confidence', async () => {
      const frame = await createSyntheticSummaryScreen(177, 0.74, 0.65);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.confidence).toBeGreaterThan(0.5);
    });

    test('strong purple has high confidence', async () => {
      const frame = await createSyntheticSummaryScreen(270, 0.30, 0.58);
      const result = await detectShiny(frame, 'dratini', 'leaf-green');

      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });
});
