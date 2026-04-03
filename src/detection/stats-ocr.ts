import sharp from 'sharp';

/**
 * Pixel-based OCR for FRLG summary stats page (page 2).
 *
 * Uses template matching against the GBA's fixed bitmap font (5x9 digit glyphs)
 * instead of Tesseract — much more reliable for this specific use case.
 *
 * Digit positions (at 240x160 after capture card trim+resize):
 *   Units digit: x=231-235 (5 wide)
 *   Tens digit:  x=225-229 (5 wide, only present for 2-digit values)
 *   Each glyph:  9 rows tall
 *
 * Stat row Y positions (top of digit glyph):
 *   HP=22, ATK=40, DEF=53, SP.ATK=66, SP.DEF=79, SPEED=92
 */

export interface StatValues {
  hp: number;
  attack: number;
  defense: number;
  spAtk: number;
  spDef: number;
  speed: number;
}

// 5x9 binary templates for digits 0-9, extracted from actual capture card output.
// Each string is 45 chars: 9 rows of 5 pixels, '1'=dark, '0'=light.
// Re-calibrated from MiraBox capture card at 240x160 resolution.
const DIGIT_TEMPLATES: Record<number, string> = {
  0: '01110' + '10011' + '10001' + '10001' + '10001' + '10001' + '10001' + '10011' + '01110',
  1: '00100' + '01100' + '01100' + '00100' + '00100' + '00100' + '00100' + '00100' + '01110',
  2: '01110' + '10011' + '10001' + '00001' + '00010' + '00100' + '01000' + '10000' + '11111',
  3: '01110' + '10011' + '00001' + '00001' + '00110' + '00011' + '00001' + '10001' + '01110',
  4: '00110' + '01110' + '01010' + '10110' + '10010' + '10010' + '11111' + '00110' + '00010',
  5: '11111' + '10000' + '10000' + '10000' + '11110' + '00011' + '00001' + '10001' + '01110',
  6: '01110' + '10011' + '10000' + '10000' + '11110' + '10011' + '10001' + '10001' + '01110',
  7: '11111' + '00011' + '00001' + '00001' + '00010' + '00010' + '00100' + '00100' + '00100',
  8: '01110' + '10011' + '10001' + '10001' + '11110' + '10011' + '10001' + '10001' + '01110',
  9: '01110' + '10011' + '10001' + '10001' + '01111' + '00011' + '00001' + '10001' + '01110',
};

const THRESHOLD = 168; // Pixel brightness threshold: < 168 = text, >= 168 = background

// Stat row y-positions (top of digit glyph, 9 rows tall)
const STAT_Y = {
  hp: 22,
  attack: 40,
  defense: 53,
  spAtk: 66,
  spDef: 79,
  speed: 92,
};

// X positions for digit columns
const UNITS_X = 231;  // Units digit: x=231 to x=235
const TENS_X = 225;   // Tens digit: x=225 to x=229

function extractGrid(pixels: Buffer, width: number, startX: number, startY: number): string {
  let grid = '';
  for (let dy = 0; dy < 9; dy++) {
    for (let dx = 0; dx < 5; dx++) {
      const v = pixels[(startY + dy) * width + (startX + dx)];
      grid += v < THRESHOLD ? '1' : '0';
    }
  }
  return grid;
}

function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

function matchDigit(grid: string): { digit: number; distance: number } | null {
  let bestDigit = -1;
  let bestDist = Infinity;
  for (const [digit, template] of Object.entries(DIGIT_TEMPLATES)) {
    const d = hammingDistance(grid, template);
    if (d < bestDist) {
      bestDist = d;
      bestDigit = parseInt(digit);
    }
  }
  // Allow up to 5 pixel differences (out of 45) for fuzzy matching
  if (bestDist <= 5) {
    return { digit: bestDigit, distance: bestDist };
  }
  return null;
}

function hasDarkPixels(pixels: Buffer, width: number, startX: number, startY: number): boolean {
  let darkCount = 0;
  for (let dy = 0; dy < 9; dy++) {
    for (let dx = 0; dx < 5; dx++) {
      if (pixels[(startY + dy) * width + (startX + dx)] < THRESHOLD) {
        darkCount++;
      }
    }
  }
  return darkCount >= 5; // Need at least 5 dark pixels to consider a digit present
}

const HUNDREDS_X = 219; // Hundreds digit: x=219 to x=223

function recognizeNumber(pixels: Buffer, width: number, statY: number): number | null {
  // Always try units digit
  const unitsGrid = extractGrid(pixels, width, UNITS_X, statY);
  const unitsMatch = matchDigit(unitsGrid);
  if (!unitsMatch) return null;

  // Check if tens digit exists
  if (hasDarkPixels(pixels, width, TENS_X, statY)) {
    const tensGrid = extractGrid(pixels, width, TENS_X, statY);
    const tensMatch = matchDigit(tensGrid);
    if (tensMatch) {
      // Check if hundreds digit exists
      if (hasDarkPixels(pixels, width, HUNDREDS_X, statY)) {
        const hundredsGrid = extractGrid(pixels, width, HUNDREDS_X, statY);
        const hundredsMatch = matchDigit(hundredsGrid);
        if (hundredsMatch) {
          return hundredsMatch.digit * 100 + tensMatch.digit * 10 + unitsMatch.digit;
        }
      }
      return tensMatch.digit * 10 + unitsMatch.digit;
    }
  }

  return unitsMatch.digit;
}

export async function extractStats(frameBuffer: Buffer): Promise<StatValues | null> {
  try {
    // Get grayscale pixel data at native 240x160
    const { data, info } = await sharp(frameBuffer)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== 240 || info.height !== 160) {
      return null;
    }

    const hp = recognizeNumber(data, info.width, STAT_Y.hp);
    const attack = recognizeNumber(data, info.width, STAT_Y.attack);
    const defense = recognizeNumber(data, info.width, STAT_Y.defense);
    const spAtk = recognizeNumber(data, info.width, STAT_Y.spAtk);
    const spDef = recognizeNumber(data, info.width, STAT_Y.spDef);
    const speed = recognizeNumber(data, info.width, STAT_Y.speed);

    if (hp === null || attack === null || defense === null ||
        spAtk === null || spDef === null || speed === null) {
      return null;
    }

    const stats: StatValues = { hp, attack, defense, spAtk, spDef, speed };

    // Validate — stats should be reasonable (1-999)
    const values = Object.values(stats);
    if (values.some(v => v < 1 || v > 999)) {
      return null;
    }

    return stats;
  } catch {
    return null;
  }
}

// No cleanup needed — no Tesseract worker
export async function cleanupStatsOcr(): Promise<void> {}
export async function cleanupOcr(): Promise<void> {}
