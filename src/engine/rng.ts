// Gen 3 PRNG — Linear Congruential Generator
// Formula: seed = (0x41C64E6D * seed + 0x6073) & 0xFFFFFFFF
// The upper 16 bits of the seed are the random value

const MULT = 0x41C64E6D;
const INC = 0x6073;

// We use BigInt for exact 32-bit multiplication (JS numbers lose precision at 32-bit)
const MULT_BI = BigInt(MULT);
const INC_BI = BigInt(INC);
const MASK_BI = BigInt(0xFFFFFFFF);

export function nextSeed(seed: number): number {
  const result = (MULT_BI * BigInt(seed >>> 0) + INC_BI) & MASK_BI;
  return Number(result);
}

export function seedToRandom(seed: number): number {
  return (seed >>> 16) & 0xFFFF;
}

// Advance seed by N frames
export function advanceSeed(seed: number, frames: number): number {
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = nextSeed(s);
  }
  return s;
}

// Fast nextSeed using Math.imul (signed 32-bit multiply, ~100× faster than BigInt).
// Mathematically identical to nextSeed — use freely for tight inner loops.
export function nextSeedFast(seed: number): number {
  return (Math.imul(seed, 0x41C64E6D) + 0x6073) >>> 0;
}

// O(log n) advance via binary-exponentiation of the LCG transformation.
// For LCG s' = s*a + c, advancing n steps: s_n = s * a^n + c * (a^n - 1) / (a - 1).
// Since we're mod 2^32, we compute a^n and the accumulated additive via doubling.
export function jumpAhead(seed: number, n: number): number {
  let mult = 1, add = 0;          // identity: s → 1*s + 0
  let curMult = 0x41C64E6D, curAdd = 0x6073;  // single step
  let k = n >>> 0;
  while (k > 0) {
    if (k & 1) {
      // compose: (mult, add) ∘ (curMult, curAdd) means apply curMult/curAdd first, then mult/add
      // s → curMult*s + curAdd → mult*(curMult*s + curAdd) + add = (mult*curMult)*s + (mult*curAdd + add)
      add = (Math.imul(mult, curAdd) + add) >>> 0;
      mult = Math.imul(mult, curMult) >>> 0;
    }
    // square: (curMult, curAdd)^2 means applying twice
    // s → curMult*s + curAdd → curMult*(curMult*s + curAdd) + curAdd = curMult²*s + curMult*curAdd + curAdd
    curAdd = (Math.imul(curMult, curAdd) + curAdd) >>> 0;
    curMult = Math.imul(curMult, curMult) >>> 0;
    k >>>= 1;
  }
  return (Math.imul(mult, seed >>> 0) + add) >>> 0;
}

// Method 1 PID generation: 2 RNG calls
// Call 1 → PID_low (lower 16 bits)
// Call 2 → PID_high (upper 16 bits)
// PID = (PID_high << 16) | PID_low
export interface Method1Result {
  pid: number;
  pidHigh: number;
  pidLow: number;
  nature: number;
  ability: number;
  gender: number; // low byte of PID for gender comparison
  iv1Seed: number; // seed after PID calls (for IV calculation)
  frame: number;
}

export function generateMethod1(seed: number, frame: number): Method1Result {
  // Two calls for PID
  const s1 = nextSeed(seed);
  const pidLow = seedToRandom(s1);
  const s2 = nextSeed(s1);
  const pidHigh = seedToRandom(s2);
  const pid = ((pidHigh << 16) | pidLow) >>> 0;

  return {
    pid,
    pidHigh,
    pidLow,
    nature: pid % 25,
    ability: pid & 1,
    gender: pid & 0xFF,
    iv1Seed: s2,
    frame,
  };
}

// Shiny check: (TID ^ SID ^ PID_high ^ PID_low) < 8
export function isShinyPID(tid: number, sid: number, pidHigh: number, pidLow: number): boolean {
  return (tid ^ sid ^ pidHigh ^ pidLow) < 8;
}

// Nature names for logging
export const NATURE_NAMES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

// IVs from Method 1 (2 more RNG calls after PID)
export interface IVs {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export function generateIVs(ivSeed: number): IVs {
  const s1 = nextSeed(ivSeed);
  const iv1 = seedToRandom(s1);
  const s2 = nextSeed(s1);
  const iv2 = seedToRandom(s2);

  return {
    hp: iv1 & 0x1F,
    atk: (iv1 >> 5) & 0x1F,
    def: (iv1 >> 10) & 0x1F,
    spe: iv2 & 0x1F,
    spa: (iv2 >> 5) & 0x1F,
    spd: (iv2 >> 10) & 0x1F,
  };
}

// Find the next shiny frame from a given seed
// Returns the frame offset and the result
export interface ShinySearchResult {
  frameOffset: number;
  result: Method1Result;
  ivs: IVs;
}

export function findNextShinyFrame(
  seed: number,
  tid: number,
  sid: number,
  maxFrames: number = 100000,
  targetNature?: number, // optional: only accept this nature
): ShinySearchResult | null {
  let currentSeed = seed;

  for (let frame = 0; frame < maxFrames; frame++) {
    const result = generateMethod1(currentSeed, frame);

    if (isShinyPID(tid, sid, result.pidHigh, result.pidLow)) {
      // Check nature filter if specified
      if (targetNature !== undefined && result.nature !== targetNature) {
        currentSeed = nextSeed(currentSeed);
        continue;
      }

      const ivs = generateIVs(result.iv1Seed);
      return { frameOffset: frame, result, ivs };
    }

    currentSeed = nextSeed(currentSeed);
  }

  return null;
}

// Identify which frame was hit given observed nature (and optionally IVs)
export function identifyHitFrame(
  initialSeed: number,
  tid: number,
  sid: number,
  observedNature: number,
  observedIVs: IVs | null,
  advanceMin: number,
  advanceMax: number,
): Array<{ advance: number; pid: number; nature: number; ivs: IVs; isShiny: boolean }> {
  const matches: Array<{ advance: number; pid: number; nature: number; ivs: IVs; isShiny: boolean }> = [];
  let seed = advanceSeed(initialSeed, advanceMin);

  for (let adv = advanceMin; adv <= advanceMax; adv++) {
    const result = generateMethod1(seed, adv);

    if (result.nature === observedNature) {
      const ivs = generateIVs(result.iv1Seed);
      const matchesIVs = !observedIVs || (
        ivs.hp === observedIVs.hp && ivs.atk === observedIVs.atk &&
        ivs.def === observedIVs.def && ivs.spa === observedIVs.spa &&
        ivs.spd === observedIVs.spd && ivs.spe === observedIVs.spe
      );

      if (matchesIVs) {
        matches.push({
          advance: adv,
          pid: result.pid,
          nature: result.nature,
          ivs,
          isShiny: isShinyPID(tid, sid, result.pidHigh, result.pidLow),
        });
      }
    }

    seed = nextSeed(seed);
  }

  return matches;
}

// Generate TID/SID from initial seed at a given advance count
// In FRLG new game, TID and SID are consecutive PRNG calls
export function generateTrainerIDs(
  initialSeed: number,
  tidAdvance: number,
): { tid: number; sid: number } {
  const seedAtTid = advanceSeed(initialSeed, tidAdvance);
  const s1 = nextSeed(seedAtTid);
  const tid = seedToRandom(s1);
  const s2 = nextSeed(s1);
  const sid = seedToRandom(s2);
  return { tid, sid };
}

// FRLG Memory Addresses
// Uses DMA-protected pointers — must dereference the pointer first, then add offset
export const FRLG_ADDRESSES = {
  rngSeed: 0x03005000,           // 4b — current PRNG seed (direct, not pointer-based)
  saveBlockPointer: 0x0300500C,  // 4b pointer to save block 2 (player data)
  tidOffset: 0x000A,             // 2b Trainer ID (offset from save block pointer)
  sidOffset: 0x000C,             // 2b Secret ID (offset from save block pointer)
};
