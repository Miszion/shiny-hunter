/**
 * Read logs/moltres-milestones.jsonl, compute per-segment mean/stddev of the
 * reset → battleDetected timeline, and emit:
 *   - JSON summary on stdout
 *   - total_frames_mean / total_frames_stddev (using GBA 59.7275 Hz)
 *
 * Filters:
 *   - --tail N       use only the last N complete cycles
 *   - --since-iso T  drop cycles whose softReset wall-clock is earlier than T
 */

import * as fs from 'fs';

interface Line { cycleIdx: number; milestone: string; t_ms_since_reset: number }
type Cycle = Record<string, number> & { cycleIdx: number };

const SEGMENTS = [
  ['softReset', 'titleSkipDone'],
  ['titleSkipDone', 'continueSelected'],
  ['continueSelected', 'saveLoaded'],
  ['saveLoaded', 'bSpamDone'],
  ['bSpamDone', 'engagePress'],
  ['engagePress', 'battleDetected'],
] as const;

const GBA_FRAME_MS = 1000 / 59.7275;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function parseArgs(argv: string[]): { tail?: number; sinceIso?: string; path: string } {
  const out: { tail?: number; sinceIso?: string; path: string } = {
    path: 'logs/moltres-milestones.jsonl',
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--tail') { out.tail = Number(v); i++; }
    else if (k === '--since-iso') { out.sinceIso = v; i++; }
    else if (k === '--path') { out.path = v; i++; }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  const text = fs.readFileSync(args.path, 'utf-8');
  const lines: Line[] = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // group by cycleIdx
  const byCycle = new Map<number, Record<string, number>>();
  for (const l of lines) {
    if (!byCycle.has(l.cycleIdx)) byCycle.set(l.cycleIdx, { cycleIdx: l.cycleIdx } as any);
    byCycle.get(l.cycleIdx)![l.milestone] = l.t_ms_since_reset;
  }

  // keep only cycles that contain ALL milestones (complete)
  const required = ['softReset', 'titleSkipDone', 'continueSelected', 'saveLoaded',
                     'bSpamDone', 'engagePress', 'battleDetected'];
  let cycles: Cycle[] = [];
  for (const c of byCycle.values()) {
    if (required.every((m) => m in c)) cycles.push(c as Cycle);
  }
  cycles.sort((a, b) => a.cycleIdx - b.cycleIdx);

  if (args.tail) cycles = cycles.slice(-args.tail);

  if (cycles.length === 0) {
    console.error('no complete cycles in input');
    process.exit(2);
  }

  const segmentStats = SEGMENTS.map(([from, to]) => {
    const dur = cycles.map((c) => c[to] - c[from]);
    return {
      from, to,
      mean_ms: mean(dur),
      stddev_ms: stddev(dur),
      min_ms: Math.min(...dur),
      max_ms: Math.max(...dur),
    };
  });

  const totalMs = cycles.map((c) => c.battleDetected - c.softReset);
  const totalFrames = totalMs.map((t) => t / GBA_FRAME_MS);
  const totalFramesMean = mean(totalFrames);
  const totalFramesStddev = stddev(totalFrames);

  const engageToDetect = cycles.map((c) => c.battleDetected - c.engagePress);
  const engageToDetectFrames = engageToDetect.map((t) => t / GBA_FRAME_MS);

  const out = {
    cycles_used: cycles.length,
    cycle_idx_range: [cycles[0].cycleIdx, cycles[cycles.length - 1].cycleIdx],
    gba_frame_ms: GBA_FRAME_MS,
    total_ms: { mean: mean(totalMs), stddev: stddev(totalMs), min: Math.min(...totalMs), max: Math.max(...totalMs) },
    total_frames: { mean: totalFramesMean, stddev: totalFramesStddev },
    engage_to_detect_ms: { mean: mean(engageToDetect), stddev: stddev(engageToDetect) },
    engage_to_detect_frames: { mean: mean(engageToDetectFrames), stddev: stddev(engageToDetectFrames) },
    segments: segmentStats,
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main();
