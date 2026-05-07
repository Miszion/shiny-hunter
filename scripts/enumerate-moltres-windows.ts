/**
 * Offline enumerator: find dense FRLG-Method-1 shiny windows for Moltres
 * across the SID coset that XORs the same trainer hash.
 *
 * Usage:
 *   npx ts-node scripts/enumerate-moltres-windows.ts
 *     --tid 24248 --sid-min 23864 --sid-max 23871
 *     --baseline-frames 1115 --range-low -100 --range-high 5000
 *
 * Prints JSON to stdout. The estimator calling this script feeds in the
 * measured per-cycle baseline (reset → battleDetected) so windows come back
 * in the same reference frame the runtime config talks in.
 */

import { generateMethod1, isShinyPID, advanceSeed } from '../src/engine/rng';

interface Args {
  tid: number;
  sidMin: number;
  sidMax: number;
  baseline: number;
  rangeLow: number;
  rangeHigh: number;
  initialSeed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tid: 24248,
    sidMin: 23864,
    sidMax: 23871,
    baseline: 1115,
    rangeLow: -100,
    rangeHigh: 5000,
    initialSeed: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--tid': args.tid = Number(v); i++; break;
      case '--sid-min': args.sidMin = Number(v); i++; break;
      case '--sid-max': args.sidMax = Number(v); i++; break;
      case '--baseline-frames': args.baseline = Number(v); i++; break;
      case '--range-low': args.rangeLow = Number(v); i++; break;
      case '--range-high': args.rangeHigh = Number(v); i++; break;
      case '--initial-seed': args.initialSeed = Number(v); i++; break;
    }
  }
  return args;
}

function isShinyAnySid(tid: number, sidMin: number, sidMax: number, pidHigh: number, pidLow: number): boolean {
  for (let sid = sidMin; sid <= sidMax; sid++) {
    if (isShinyPID(tid, sid, pidHigh, pidLow)) return true;
  }
  return false;
}

function main(): void {
  const args = parseArgs(process.argv);
  const advLow = args.baseline + args.rangeLow;
  const advHigh = args.baseline + args.rangeHigh;
  if (advLow < 0) throw new Error('range_low pushed advance below 0');

  // Walk seeds in order from initial -> advLow, then iterate to advHigh.
  let seed = advanceSeed(args.initialSeed, advLow);
  const shinyAdvances: number[] = [];
  for (let adv = advLow; adv <= advHigh; adv++) {
    const r = generateMethod1(seed, adv);
    if (isShinyAnySid(args.tid, args.sidMin, args.sidMax, r.pidHigh, r.pidLow)) {
      shinyAdvances.push(adv);
    }
    // step forward one PRNG call
    seed = (Math.imul(seed, 0x41C64E6D) + 0x6073) >>> 0;
  }

  // Density windows. For every shiny advance c, count how many shiny advances
  // fall in [c-r, c+r] across multiple radii. We can only ADD wait time, not
  // subtract, so eligible centers must be reachable: c >= baseline. Among
  // reachable candidates, prefer (1) most hits in window, (2) closest to
  // baseline (smallest added wait). Ties broken by lower advance.
  const radii = [5, 10, 20, 40];
  const reachable = shinyAdvances.filter((c) => c >= args.baseline);
  const GBA_FRAME_MS = 1000 / 59.7275;
  const windows = radii.map((r) => {
    let bestCenter: number | null = null;
    let bestCount = 0;
    let bestList: number[] = [];
    let bestDistance = Infinity;
    for (const c of reachable) {
      const inWindow = shinyAdvances.filter((a) => a >= c - r && a <= c + r);
      const distance = c - args.baseline;
      // prefer higher hit count; tie-break on smaller distance
      if (
        inWindow.length > bestCount ||
        (inWindow.length === bestCount && distance < bestDistance)
      ) {
        bestCount = inWindow.length;
        bestCenter = c;
        bestList = inWindow;
        bestDistance = distance;
      }
    }
    const windowSize = 2 * r + 1;
    const perCycleOddsUniform = bestCount > 0 ? bestCount / windowSize : 0;
    const recommendedPreEngageWaitMs =
      bestCenter == null ? 0 : Math.max(0, Math.round((bestCenter - args.baseline) * GBA_FRAME_MS));
    return {
      radius: r,
      window_size_frames: windowSize,
      best_center_advance: bestCenter,
      hit_count: bestCount,
      per_cycle_odds_uniform: perCycleOddsUniform,
      recommended_pre_engage_wait_ms: recommendedPreEngageWaitMs,
      shiny_advances_in_window: bestList,
      reachable: bestCenter != null,
      added_seconds_per_cycle: recommendedPreEngageWaitMs / 1000,
    };
  });

  // Closest reachable shiny — useful as the "minimum-wait" recommendation.
  const closestReachable = reachable.length > 0 ? reachable[0] : null;
  const closestReachableWaitMs = closestReachable != null
    ? Math.round((closestReachable - args.baseline) * GBA_FRAME_MS)
    : null;

  const out = {
    args,
    advance_range: { low: advLow, high: advHigh, total: advHigh - advLow + 1 },
    total_shiny_advances_in_range: shinyAdvances.length,
    reachable_shiny_advances_in_range: reachable.length,
    baseline_per_cycle_odds_uniform: shinyAdvances.length / (advHigh - advLow + 1),
    closest_reachable_shiny: closestReachable,
    closest_reachable_pre_engage_wait_ms: closestReachableWaitMs,
    windows,
    all_shiny_advances: shinyAdvances,
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
