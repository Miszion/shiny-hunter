import sharp from 'sharp';
import { DetectionResult, SpriteRegion, ColorSignature, HueRange } from '../types';
import { getPalette } from './color-palettes';
import { getSummarySpriteRegion } from './sprite-regions';

// Convert RGB to HSL
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      case b:
        h = ((r - g) / d + 4) * 60;
        break;
    }
  }

  return { h, s, l };
}

function hueInRange(hue: number, range: HueRange): boolean {
  if (range.min <= range.max) {
    return hue >= range.min && hue <= range.max;
  }
  return hue >= range.min || hue <= range.max;
}

function matchesSignature(h: number, s: number, l: number, sig: ColorSignature): boolean {
  if (s < sig.satMin || l < sig.valMin) return false;
  return sig.hueRanges.some((range) => hueInRange(h, range));
}

interface RawImageInfo {
  width: number;
  height: number;
  channels: number;
}

export async function detectShiny(
  frameBuffer: Buffer,
  pokemon: string,
  game: string
): Promise<DetectionResult> {
  const { data: rawData, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });

  const onSummary = isSummaryScreenFromRaw(rawData, info);
  if (!onSummary) {
    return {
      isShiny: false,
      confidence: 0,
      normalPixels: 0,
      shinyPixels: 0,
      totalSampled: 0,
      debugInfo: 'not on summary screen',
    };
  }

  // PRIMARY METHOD: Check UI border color around Pokemon name
  // In FRLG, this border is purple/lavender for normal, teal/blue for shiny
  const borderResult = detectShinyByBorder(rawData, info);

  // SECONDARY METHOD: Sprite color analysis (palette-based)
  const palette = getPalette(pokemon);
  const region = getSummarySpriteRegion(game);
  const spriteResult = palette
    ? analyzeRegionFromRaw(rawData, info, region, palette)
    : null;

  // Combine: border detection is the primary signal
  const isShiny = borderResult.isShiny;
  const totalSampled = spriteResult ? spriteResult.totalSampled : borderResult.borderPixelsSampled;

  const debugParts = [
    `border=${borderResult.isShiny ? 'SHINY(teal)' : 'normal(purple)'}`,
    `teal=${borderResult.tealPixels} purple=${borderResult.purplePixels}`,
  ];
  if (spriteResult) {
    debugParts.push(`sprite: normal=${spriteResult.normalPixels} shiny=${spriteResult.shinyPixels} total=${spriteResult.totalSampled}`);
  }

  return {
    isShiny,
    confidence: borderResult.confidence,
    normalPixels: spriteResult?.normalPixels ?? borderResult.purplePixels,
    shinyPixels: spriteResult?.shinyPixels ?? borderResult.tealPixels,
    totalSampled,
    debugInfo: debugParts.join(' | '),
  };
}

// FRLG summary screen border detection
// The UI panel/border around the Pokemon name area changes color:
// - Normal Pokemon: purple/lavender (hue ~270°, sat > 0.2)
// - Shiny Pokemon: teal/cyan-blue (hue ~160-200°, sat > 0.2)
// Sample multiple points in the border region for robustness
interface BorderResult {
  isShiny: boolean;
  confidence: number;
  tealPixels: number;
  purplePixels: number;
  borderPixelsSampled: number;
}

function detectShinyByBorder(data: Buffer, info: RawImageInfo): BorderResult {
  const getPixel = (px: number, py: number) => {
    const cx = Math.min(px, info.width - 1);
    const cy = Math.min(py, info.height - 1);
    const idx = (cy * info.width + cx) * info.channels;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  };

  // FRLG summary screen panel frame — calibrated from real screenshots:
  // Normal:  panel header = purple hsl(270°, 23%, 58%) — rgb(148,123,173)
  // Shiny:   panel header = teal  hsl(177°, 74%, 65%) — rgb(98,232,225)
  //
  // Best detection points are the panel header/frame pixels which always
  // show the colored border regardless of which Pokemon is displayed
  const borderPoints = [
    { x: 10, y: 20 },   // panel header left (most reliable)
    { x: 75, y: 20 },   // panel header right (most reliable)
    { x: 10, y: 30 },   // below header (may overlap sprite area)
    { x: 40, y: 17 },   // mid header
    { x: 60, y: 17 },   // mid-right header
  ];

  let tealPixels = 0;
  let purplePixels = 0;
  let sampled = 0;

  for (const pt of borderPoints) {
    const p = getPixel(pt.x, pt.y);
    const hsl = rgbToHsl(p.r, p.g, p.b);

    // Skip achromatic pixels (gray/white/black) — need some saturation
    if (hsl.s < 0.10 || hsl.l < 0.2 || hsl.l > 0.9) continue;
    sampled++;

    // Teal/cyan: hue 160-200°, sat > 0.2 (shiny border is very saturated ~70%)
    if (hsl.h >= 150 && hsl.h <= 210 && hsl.s > 0.2) tealPixels++;
    // Purple/lavender: hue 240-320° (normal border is ~270° with ~23% sat)
    if (hsl.h >= 240 && hsl.h <= 320 && hsl.s > 0.10) purplePixels++;
  }

  // Shiny if more teal than purple in the border
  const isShiny = tealPixels > purplePixels && tealPixels >= 2;
  const total = tealPixels + purplePixels;
  const confidence = total > 0 ? Math.abs(tealPixels - purplePixels) / total : 0;

  return { isShiny, confidence, tealPixels, purplePixels, borderPixelsSampled: sampled };
}

function isSummaryScreenFromRaw(data: Buffer, info: RawImageInfo): boolean {
  const getPixel = (px: number, py: number) => {
    const cx = Math.min(px, info.width - 1);
    const cy = Math.min(py, info.height - 1);
    const idx = (cy * info.width + cx) * info.channels;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  };

  // PRIMARY CHECK: The summary screen's defining feature is the purple/teal border
  // on the left panel. Sample border points and check for purple (normal) or teal (shiny).
  // This is the most reliable signal and distinguishes summary from other screens.
  const borderCheckPoints = [
    { x: 10, y: 20 },
    { x: 75, y: 20 },
    { x: 10, y: 30 },
  ];
  let borderPurple = 0;
  let borderTeal = 0;
  for (const pt of borderCheckPoints) {
    const p = getPixel(pt.x, pt.y);
    const hsl = rgbToHsl(p.r, p.g, p.b);
    // Need some saturation and mid-lightness (not white/black)
    if (hsl.s < 0.08 || hsl.l < 0.2 || hsl.l > 0.85) continue;
    // Purple: hue 240-320 (normal summary border)
    if (hsl.h >= 240 && hsl.h <= 320) borderPurple++;
    // Teal: hue 150-210 (shiny summary border)
    if (hsl.h >= 150 && hsl.h <= 210) borderTeal++;
  }
  const hasSummaryBorder = (borderPurple + borderTeal) >= 2;

  // SECONDARY CHECK: Teal page indicator near top center (120, 5)
  const pageIndicator = getPixel(120, 5);
  const piHsl = rgbToHsl(pageIndicator.r, pageIndicator.g, pageIndicator.b);
  const hasTealIndicator = piHsl.h >= 160 && piHsl.h <= 200 && piHsl.s > 0.2;

  // TERTIARY CHECK: Right side should be light-ish (cream/white/beige), not dark
  // Thresholds lowered for capture card images which are darker than emulator screenshots
  const rightPoints = [
    getPixel(200, 60),
    getPixel(220, 80),
    getPixel(200, 100),
  ];
  let lightCount = 0;
  for (const p of rightPoints) {
    if (p.r > 120 && p.g > 110 && p.b > 90 && (p.r + p.g + p.b) > 380) lightCount++;
  }

  // REJECT: Uniform blue/teal screens (help screen, menus) — right side must be
  // distinctly lighter than the border. Help screen is uniformly blue everywhere.
  // Summary has purple/teal LEFT + cream/white RIGHT = high contrast.
  if (hasSummaryBorder && borderTeal >= 2 && lightCount === 0) return false;

  // Summary confirmed if: has the characteristic purple/teal border + light right side
  if (hasSummaryBorder && lightCount >= 1) return true;

  // Also accept: purple border + teal indicator (normal Pokemon, capture card dark frame)
  if (borderPurple >= 2 && hasTealIndicator) return true;

  return false;
}

interface SpriteAnalysis {
  normalPixels: number;
  shinyPixels: number;
  totalSampled: number;
}

function analyzeRegionFromRaw(
  data: Buffer,
  info: RawImageInfo,
  region: SpriteRegion,
  palette: { normal: ColorSignature; shiny: ColorSignature }
): SpriteAnalysis {
  const x = Math.min(region.x, info.width - 1);
  const y = Math.min(region.y, info.height - 1);
  const w = Math.min(region.width, info.width - x);
  const h = Math.min(region.height, info.height - y);

  let normalPixels = 0;
  let shinyPixels = 0;
  let totalSampled = 0;

  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const idx = (py * info.width + px) * info.channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const hsl = rgbToHsl(r, g, b);

      if (hsl.l < 0.15 || hsl.l > 0.9 || hsl.s < 0.15) continue;
      totalSampled++;

      if (matchesSignature(hsl.h, hsl.s, hsl.l, palette.normal)) normalPixels++;
      if (matchesSignature(hsl.h, hsl.s, hsl.l, palette.shiny)) shinyPixels++;
    }
  }

  return { normalPixels, shinyPixels, totalSampled };
}
