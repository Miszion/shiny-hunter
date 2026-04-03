/**
 * SID cracker v2 - brute force across plausible stat readings.
 *
 * The GBA pixel font at native resolution makes some digits ambiguous.
 * We know for certain: HP=58, Nature=Serious, Level=24, TID=24248
 * For ATK and SPA, we try all valid values and find which combo
 * produces a Method 1 shiny PID.
 */

import { computeIVRanges } from './src/engine/iv-calc';
import { findPIDCandidates, getUniquePIDs } from './src/engine/pid-finder';
import { NATURE_NAMES } from './src/engine/rng';
import { enumerateSIDCandidates, scorePIDObservation, getBestSID, getRemainingCount } from './src/engine/sid-deduction';

const TID = 24248;
const natureIdx = 12; // Serious
const level = 24;
const pokemon = 'dratini';

// Confident readings
const HP = 58;
// DEF could be 28, SPD could be 30, SPE could be 30 - but let's also try nearby values
// ATK and SPA are definitely wrong (impossible values)

// All valid stat values for Dratini Lv24 Serious
const validATK = [35, 36, 37, 38, 39, 40, 41, 42, 43];
const validDEF = [26, 27, 28, 29, 30, 31, 32, 33, 34];
const validSPA = [29, 30, 31, 32, 33, 34, 35, 36];
const validSPD = [29, 30, 31, 32, 33, 34, 35, 36];
const validSPE = [29, 30, 31, 32, 33, 34, 35, 36];

// Narrow it down: DEF, SPD, SPE readings are likely correct or close
// Try a focused set: DEF near 28, SPD near 30, SPE near 30
const tryDEF = [27, 28, 29, 30];
const trySPD = [29, 30, 31];
const trySPE = [29, 30, 31];

// ATK and SPA: try all valid values since we clearly misread them
const tryATK = validATK;
const trySPA = validSPA;

const advanceWindow = { min: 0, max: 20000 };

console.log(`SID CRACKER v2 - Brute Force Stat Combinations`);
console.log(`===============================================`);
console.log(`TID: ${TID}, Serious nature, Lv24 Dratini`);
console.log(`Confident: HP=58`);
console.log(`Trying: ATK=${tryATK.join('/')}, DEF=${tryDEF.join('/')}, SPA=${trySPA.join('/')}, SPD=${trySPD.join('/')}, SPE=${trySPE.join('/')}`);
console.log(`Total combos to test: ${tryATK.length * tryDEF.length * trySPA.length * trySPD.length * trySPE.length}`);
console.log();

interface Result {
  stats: { atk: number; def: number; spa: number; spd: number; spe: number };
  pidCount: number;
  shinyPIDs: Array<{ pid: number; pidHigh: number; pidLow: number; sid: number }>;
}

const results: Result[] = [];

for (const atk of tryATK) {
  for (const def of tryDEF) {
    for (const spa of trySPA) {
      for (const spd of trySPD) {
        for (const spe of trySPE) {
          const stats = { hp: HP, attack: atk, defense: def, spAtk: spa, spDef: spd, speed: spe };
          const ivRanges = computeIVRanges(pokemon, level, 'Serious', stats);
          if (!ivRanges) continue;

          const candidates = findPIDCandidates(natureIdx, ivRanges, advanceWindow);
          if (candidates.length === 0) continue;

          const uniquePIDs = getUniquePIDs(candidates);

          // Check which PIDs are shiny for some SID
          const shinyPIDs: Array<{ pid: number; pidHigh: number; pidLow: number; sid: number }> = [];
          for (const p of uniquePIDs) {
            for (let s = 0; s < 8; s++) {
              const sid = TID ^ p.pidHigh ^ p.pidLow ^ s;
              if (sid >= 0 && sid <= 65535) {
                // Verify this SID is actually reachable (exists in seed table)
                shinyPIDs.push({ pid: p.pid, pidHigh: p.pidHigh, pidLow: p.pidLow, sid });
              }
            }
          }

          if (shinyPIDs.length > 0) {
            results.push({
              stats: { atk, def, spa, spd, spe },
              pidCount: uniquePIDs.length,
              shinyPIDs,
            });
          }
        }
      }
    }
  }
  process.stdout.write(`.`);
}

console.log(`\n\nFound ${results.length} stat combos that produce shiny-capable Method 1 PIDs\n`);

// Now cross-reference with the SID candidate pool
console.log(`--- Cross-referencing with SID candidate pool ---`);
const allSIDScores = enumerateSIDCandidates(TID);
const totalCandidates = getRemainingCount(allSIDScores);
console.log(`SID candidate pool: ${totalCandidates} candidates for TID ${TID}\n`);

// Get the set of valid SIDs from the seed table
const validSIDs = new Set(allSIDScores.filter(s => !s.eliminated).map(s => s.sid));

for (const r of results) {
  // Check which of the shiny PIDs have SIDs in the valid pool
  const matchingSIDs = r.shinyPIDs.filter(p => validSIDs.has(p.sid));
  if (matchingSIDs.length > 0) {
    console.log(`Stats ATK=${r.stats.atk} DEF=${r.stats.def} SPA=${r.stats.spa} SPD=${r.stats.spd} SPE=${r.stats.spe}:`);
    console.log(`  ${r.pidCount} unique PIDs, ${matchingSIDs.length} with valid SIDs`);

    // Group by SID
    const bySID = new Map<number, typeof matchingSIDs>();
    for (const m of matchingSIDs) {
      const arr = bySID.get(m.sid) || [];
      arr.push(m);
      bySID.set(m.sid, arr);
    }

    for (const [sid, pids] of bySID) {
      console.log(`  -> SID ${sid} (0x${sid.toString(16).padStart(4, '0')}): ${pids.length} PID(s)`);
      for (const p of pids.slice(0, 3)) {
        console.log(`     PID=0x${(p.pid >>> 0).toString(16).padStart(8, '0')}`);
      }
    }
    console.log();
  }
}

// Now try to actually resolve: for each result, run the full SID elimination
console.log(`\n--- Attempting full SID resolution ---`);
for (const r of results) {
  const matchingSIDs = r.shinyPIDs.filter(p => validSIDs.has(p.sid));
  if (matchingSIDs.length === 0) continue;

  // For each unique PID in this stat combo, try scoring as shiny
  const uniqueShinyPIDs = new Map<number, typeof matchingSIDs[0]>();
  for (const m of matchingSIDs) {
    if (!uniqueShinyPIDs.has(m.pid)) uniqueShinyPIDs.set(m.pid, m);
  }

  for (const [pid, m] of uniqueShinyPIDs) {
    const freshScores = enumerateSIDCandidates(TID);
    const obs = {
      attempt: 0,
      pid: m.pid,
      pidHigh: m.pidHigh,
      pidLow: m.pidLow,
      nature: 'Serious',
      isShiny: true,
      timestamp: Date.now(),
    };
    scorePIDObservation(TID, freshScores, obs);
    const remaining = getRemainingCount(freshScores);
    const best = getBestSID(freshScores, 0);

    if (remaining <= 10) {
      const alive = freshScores.filter(s => !s.eliminated);
      console.log(`Stats [ATK=${r.stats.atk} DEF=${r.stats.def} SPA=${r.stats.spa} SPD=${r.stats.spd} SPE=${r.stats.spe}]`);
      console.log(`  PID 0x${(pid >>> 0).toString(16).padStart(8, '0')}: ${remaining} SIDs survive`);
      console.log(`  Survivors: [${alive.map(s => `${s.sid}(0x${s.sid.toString(16).padStart(4, '0')})`).join(', ')}]`);
      if (best !== null) {
        console.log(`\n  *** SID RESOLVED: ${best} (0x${best.toString(16).padStart(4, '0')}) ***`);
      }
      console.log();
    }
  }
}
