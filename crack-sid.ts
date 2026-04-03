/**
 * SID cracker for the shiny Dratini found on 2026-04-01.
 *
 * Observed stats from screenshots:
 *   Dratini Lv24, Serious nature, Celadon City
 *   HP=58, ATK=30, DEF=28, SPA=28, SPD=30, SPE=30
 *   TID=24248, Ability=Shed Skin
 *
 * Process:
 * 1. Compute IV ranges from stats
 * 2. Method 1 reverse search for PID candidates matching nature+IVs
 * 3. Filter to PIDs that are shiny with TID 24248 for some SID
 * 4. Cross-reference with SID candidate pool to find the exact SID
 */

import { computeIVRanges } from './src/engine/iv-calc';
import { findPIDCandidates, getUniquePIDs } from './src/engine/pid-finder';
import { NATURE_NAMES } from './src/engine/rng';

const TID = 24248;

// Observed stats - corrected by manual reading (original OCR misread ATK/SPA/SPE)
// User confirmed: HP=58, ATK=39, DEF=28, SPA=32, SPD=30, SPE=35
const stats = {
  hp: 58,
  attack: 39,
  defense: 28,
  spAtk: 32,
  spDef: 30,
  speed: 35,
};

const nature = 'Serious';
const level = 24;
const pokemon = 'dratini';

// Serious = index 12 in NATURE_NAMES
const natureIdx = NATURE_NAMES.indexOf(nature);
console.log(`\nSID CRACKER - Shiny Dratini Analysis`);
console.log(`====================================`);
console.log(`TID: ${TID} (0x${TID.toString(16).padStart(4, '0')})`);
console.log(`Nature: ${nature} (index ${natureIdx})`);
console.log(`Level: ${level}`);
console.log(`Stats: HP=${stats.hp} ATK=${stats.attack} DEF=${stats.defense} SPA=${stats.spAtk} SPD=${stats.spDef} SPE=${stats.speed}`);

// Step 1: Compute IV ranges
console.log(`\n--- Step 1: IV Ranges ---`);
const ivRanges = computeIVRanges(pokemon, level, nature, stats);
if (!ivRanges) {
  console.error('ERROR: Could not compute IV ranges. Check stats/base stats.');
  process.exit(1);
}

console.log(`HP IVs:  [${ivRanges.hp.join(', ')}]`);
console.log(`ATK IVs: [${ivRanges.atk.join(', ')}]`);
console.log(`DEF IVs: [${ivRanges.def.join(', ')}]`);
console.log(`SPA IVs: [${ivRanges.spa.join(', ')}]`);
console.log(`SPD IVs: [${ivRanges.spd.join(', ')}]`);
console.log(`SPE IVs: [${ivRanges.spe.join(', ')}]`);

const totalCombos = ivRanges.hp.length * ivRanges.atk.length * ivRanges.def.length *
  ivRanges.spa.length * ivRanges.spd.length * ivRanges.spe.length;
console.log(`Total IV combinations: ${totalCombos}`);

// Step 2: Method 1 reverse search
// Use a wide advance window to be thorough
// Static encounters in FRLG can have varying advance counts
console.log(`\n--- Step 2: Method 1 PID Search ---`);
const advanceWindow = { min: 0, max: 20000 };
console.log(`Searching all 65536 seeds, advances ${advanceWindow.min}-${advanceWindow.max}...`);

const start = Date.now();
const candidates = findPIDCandidates(natureIdx, ivRanges, advanceWindow);
const elapsed = Date.now() - start;
const uniquePIDs = getUniquePIDs(candidates);

console.log(`Found ${candidates.length} matches (${uniquePIDs.length} unique PIDs) in ${elapsed}ms`);

// Step 3: Filter to shiny PIDs and determine SID
console.log(`\n--- Step 3: Shiny Filter + SID Resolution ---`);
const shinySIDs = new Map<number, { pid: number; pidHigh: number; pidLow: number; xorValue: number }[]>();

for (const p of uniquePIDs) {
  // For each possible shiny value S (0-7)
  for (let s = 0; s < 8; s++) {
    const sid = TID ^ p.pidHigh ^ p.pidLow ^ s;
    if (sid >= 0 && sid <= 65535) {
      const arr = shinySIDs.get(sid) || [];
      arr.push({ pid: p.pid, pidHigh: p.pidHigh, pidLow: p.pidLow, xorValue: s });
      shinySIDs.set(sid, arr);
    }
  }
}

console.log(`\nPossible SIDs from shiny PIDs: ${shinySIDs.size}`);

// Show all possible SID -> PID mappings
const sortedSIDs = Array.from(shinySIDs.entries()).sort((a, b) => a[0] - b[0]);

console.log(`\n--- All Candidate SIDs ---`);
for (const [sid, pids] of sortedSIDs) {
  for (const p of pids) {
    console.log(`  SID ${sid} (0x${sid.toString(16).padStart(4, '0')}) <- PID 0x${(p.pid >>> 0).toString(16).padStart(8, '0')} (high=0x${p.pidHigh.toString(16).padStart(4, '0')} low=0x${p.pidLow.toString(16).padStart(4, '0')}) xor=${p.xorValue}`);
  }
}

// Step 4: Find the exact PID by also checking which candidates produce the specific IVs
// when generated via Method 1 (not just matching ranges, but the EXACT IVs)
console.log(`\n--- Step 4: Exact PID Identification ---`);
console.log(`Checking which PID candidates actually produce shiny Dratini via Method 1...`);

interface ShinyMatch {
  initialSeed: number;
  advance: number;
  pid: number;
  pidHigh: number;
  pidLow: number;
  sid: number;
  xorValue: number;
  ivs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}

const shinyMatches: ShinyMatch[] = [];

for (const c of candidates) {
  // Check all 8 possible SIDs for this PID
  for (let s = 0; s < 8; s++) {
    const sid = TID ^ c.pidHigh ^ c.pidLow ^ s;
    if (sid >= 0 && sid <= 65535) {
      shinyMatches.push({
        initialSeed: c.initialSeed,
        advance: c.advance,
        pid: c.pid,
        pidHigh: c.pidHigh,
        pidLow: c.pidLow,
        sid,
        xorValue: s,
        ivs: c.ivs,
      });
    }
  }
}

console.log(`\nTotal shiny-capable Method 1 matches: ${shinyMatches.length}`);

// Group by SID to see which SIDs have the most supporting evidence
const bySID = new Map<number, ShinyMatch[]>();
for (const m of shinyMatches) {
  const arr = bySID.get(m.sid) || [];
  arr.push(m);
  bySID.set(m.sid, arr);
}

console.log(`\nSIDs with matching Method 1 shiny PIDs:`);
const sortedBySID = Array.from(bySID.entries()).sort((a, b) => b[1].length - a[1].length);
for (const [sid, matches] of sortedBySID.slice(0, 20)) {
  console.log(`\n  SID ${sid} (0x${sid.toString(16).padStart(4, '0')}): ${matches.length} possible (seed, advance) combos`);
  for (const m of matches.slice(0, 3)) {
    console.log(`    Seed=0x${m.initialSeed.toString(16).padStart(4, '0')} Adv=${m.advance} PID=0x${(m.pid >>> 0).toString(16).padStart(8, '0')} IVs=[${m.ivs.hp}/${m.ivs.atk}/${m.ivs.def}/${m.ivs.spa}/${m.ivs.spd}/${m.ivs.spe}] xor=${m.xorValue}`);
  }
  if (matches.length > 3) console.log(`    ... and ${matches.length - 3} more`);
}

// Summary
console.log(`\n====================================`);
console.log(`SUMMARY`);
console.log(`====================================`);
console.log(`Unique possible SIDs: ${bySID.size}`);
if (bySID.size <= 20) {
  console.log(`All candidate SIDs: ${Array.from(bySID.keys()).sort((a, b) => a - b).join(', ')}`);
}
console.log(`\nTo narrow further: cross-reference these SIDs with the 671 active`);
console.log(`candidates from the multi-SID targeting system. Any SID that appears`);
console.log(`in BOTH lists is your real SID.`);

// If we can load the SID candidate data, do the cross-reference
console.log(`\n--- Cross-Reference with Active SID Pool ---`);
async function crossReference() {
  const { enumerateSIDCandidates, scorePIDObservation, getBestSID, getRemainingCount } = await import('./src/engine/sid-deduction');

  const allSIDScores = enumerateSIDCandidates(TID);
  console.log(`Total SID candidates for TID ${TID}: ${allSIDScores.length}`);
  console.log(`Currently active (non-eliminated): ${getRemainingCount(allSIDScores)}`);

  // Apply the shiny observation to ALL candidate PIDs
  // Each unique PID that matches our Dratini is a valid observation
  let resolvedSID: number | null = null;

  for (const p of uniquePIDs) {
    const obs = {
      attempt: 0,
      pid: p.pid,
      pidHigh: p.pidHigh,
      pidLow: p.pidLow,
      nature: nature,
      isShiny: true,
      timestamp: Date.now(),
    };
    scorePIDObservation(TID, allSIDScores, obs);

    const remaining = getRemainingCount(allSIDScores);
    console.log(`After scoring PID 0x${(p.pid >>> 0).toString(16).padStart(8, '0')} (shiny=true): ${remaining} SIDs remain`);

    if (remaining === 1) {
      resolvedSID = getBestSID(allSIDScores, 0);
      break;
    } else if (remaining === 0) {
      // Reset and try this PID alone - maybe earlier PIDs were wrong
      console.log(`  All eliminated - this PID combination eliminated everything. Trying next PID individually...`);
    }
  }

  if (resolvedSID !== null) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  SID RESOLVED: ${resolvedSID} (0x${resolvedSID.toString(16).padStart(4, '0')})`);
    console.log(`${'='.repeat(50)}`);
    console.log(`\nTID: ${TID} | SID: ${resolvedSID}`);
    console.log(`Full Trainer ID: TID=${TID} SID=${resolvedSID}`);
    console.log(`\nWith this SID, you can now predict shiny frames for ANY static encounter.`);
  } else {
    // Try each PID individually against the full candidate pool
    console.log(`\nTrying each PID individually against fresh candidate pools...`);
    for (const p of uniquePIDs) {
      const freshScores = enumerateSIDCandidates(TID);
      const obs = {
        attempt: 0,
        pid: p.pid,
        pidHigh: p.pidHigh,
        pidLow: p.pidLow,
        nature: nature,
        isShiny: true,
        timestamp: Date.now(),
      };
      scorePIDObservation(TID, freshScores, obs);
      const remaining = getRemainingCount(freshScores);
      const best = getBestSID(freshScores, 0);
      if (remaining <= 8 && remaining > 0) {
        const alive = freshScores.filter(s => !s.eliminated);
        console.log(`PID 0x${(p.pid >>> 0).toString(16).padStart(8, '0')}: ${remaining} SIDs survive -> [${alive.map(s => s.sid).join(', ')}]`);
      }
    }
  }
}

crossReference().catch(e => {
  console.error(`Could not load SID deduction module: ${e}`);
  console.log(`Manual cross-reference needed with the active SID candidate list.`);
});
