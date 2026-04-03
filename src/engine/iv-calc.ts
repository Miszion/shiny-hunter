/**
 * IV calculator for Gen 3 Pokemon.
 *
 * At Lv5 with 0 EVs, we can compute IV ranges from visible stat values.
 *
 * Gen 3 stat formula:
 *   HP:    floor((2*Base + IV + floor(EV/4)) * Level / 100) + Level + 10
 *   Other: floor((floor((2*Base + IV + floor(EV/4)) * Level / 100) + 5) * NatureMod)
 *
 * At Lv5, EVs=0:
 *   HP:    floor((2*Base + IV) * 5 / 100) + 15
 *   Other: floor((floor((2*Base + IV) * 5 / 100) + 5) * NatureMod)
 *
 * NatureMod: 1.1 for +stat, 0.9 for -stat, 1.0 for neutral
 */

import { NATURE_NAMES, IVs } from './rng';

// Nature stat modifiers: [+stat index, -stat index] (0=Atk,1=Def,2=Spe,3=SpA,4=SpD)
// Neutral natures have same +/- (effectively no change)
const NATURE_MODS: Record<string, { plus: number; minus: number }> = {};
for (let i = 0; i < 25; i++) {
  const plus = Math.floor(i / 5);  // 0=Atk,1=Def,2=Spe,3=SpA,4=SpD
  const minus = i % 5;
  NATURE_MODS[NATURE_NAMES[i]] = { plus, minus };
}

// Stat order for nature modifiers: Atk=0, Def=1, Spe=2, SpA=3, SpD=4
function getNatureMod(nature: string, statIdx: number): number {
  const nm = NATURE_MODS[nature];
  if (!nm || nm.plus === nm.minus) return 1.0; // neutral nature
  if (statIdx === nm.plus) return 1.1;
  if (statIdx === nm.minus) return 0.9;
  return 1.0;
}

export interface BaseStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

// Gen 3 base stats
const BASE_STATS: Record<string, BaseStats> = {
  // Starters
  charmander: { hp: 39, atk: 52, def: 43, spa: 60, spd: 50, spe: 65 },
  squirtle:   { hp: 44, atk: 48, def: 65, spa: 50, spd: 64, spe: 43 },
  bulbasaur:  { hp: 45, atk: 49, def: 49, spa: 65, spd: 65, spe: 45 },
  // Fossil Pokemon (revived at Lv5 in FRLG)
  aerodactyl: { hp: 80, atk: 105, def: 65, spa: 60, spd: 75, spe: 130 },
  kabuto:     { hp: 30, atk: 80, def: 90, spa: 55, spd: 45, spe: 55 },
  omanyte:    { hp: 35, atk: 40, def: 100, spa: 90, spd: 55, spe: 35 },
  // Gift Pokemon
  lapras:     { hp: 130, atk: 85, def: 80, spa: 85, spd: 95, spe: 60 }, // Lv25 Silph Co gift
  // Wild Pokemon
  pikachu:    { hp: 35, atk: 55, def: 30, spa: 50, spd: 40, spe: 90 },
  nidoranm:   { hp: 46, atk: 57, def: 40, spa: 40, spd: 40, spe: 50 }, // Nidoran♂
  nidoranf:   { hp: 55, atk: 47, def: 52, spa: 40, spd: 40, spe: 41 }, // Nidoran♀
  // Casino Pokemon
  dratini:    { hp: 41, atk: 64, def: 45, spa: 50, spd: 50, spe: 50 },
  // Gift Pokemon (Celadon Mansion — Lv25 in FRLG)
  eevee:      { hp: 55, atk: 55, def: 50, spa: 45, spd: 65, spe: 55 },
};

function calcHPStat(base: number, iv: number, level: number): number {
  return Math.floor((2 * base + iv) * level / 100) + level + 10;
}

function calcOtherStat(base: number, iv: number, level: number, natureMod: number): number {
  return Math.floor((Math.floor((2 * base + iv) * level / 100) + 5) * natureMod);
}

/**
 * Given observed stat values, nature, level, and base stats,
 * compute the set of possible IVs (0-31) for each stat.
 */
export function computeIVRanges(
  pokemon: string,
  level: number,
  nature: string,
  stats: { hp: number; attack: number; defense: number; spAtk: number; spDef: number; speed: number },
): { hp: number[]; atk: number[]; def: number[]; spa: number[]; spd: number[]; spe: number[] } | null {
  const base = BASE_STATS[pokemon.toLowerCase()];
  if (!base) return null;

  const result = {
    hp: [] as number[],
    atk: [] as number[],
    def: [] as number[],
    spa: [] as number[],
    spd: [] as number[],
    spe: [] as number[],
  };

  // Stat indices for nature: Atk=0, Def=1, Spe=2, SpA=3, SpD=4
  for (let iv = 0; iv <= 31; iv++) {
    if (calcHPStat(base.hp, iv, level) === stats.hp) result.hp.push(iv);
    if (calcOtherStat(base.atk, iv, level, getNatureMod(nature, 0)) === stats.attack) result.atk.push(iv);
    if (calcOtherStat(base.def, iv, level, getNatureMod(nature, 1)) === stats.defense) result.def.push(iv);
    if (calcOtherStat(base.spe, iv, level, getNatureMod(nature, 2)) === stats.speed) result.spe.push(iv);
    if (calcOtherStat(base.spa, iv, level, getNatureMod(nature, 3)) === stats.spAtk) result.spa.push(iv);
    if (calcOtherStat(base.spd, iv, level, getNatureMod(nature, 4)) === stats.spDef) result.spd.push(iv);
  }

  // Sanity check — each stat should have at least 1 matching IV
  if (Object.values(result).some(arr => arr.length === 0)) return null;

  return result;
}

/**
 * Check if an IVs object matches any combination in the IV ranges.
 */
export function ivsMatchRanges(
  ivs: IVs,
  ranges: { hp: number[]; atk: number[]; def: number[]; spa: number[]; spd: number[]; spe: number[] },
): boolean {
  return ranges.hp.includes(ivs.hp)
    && ranges.atk.includes(ivs.atk)
    && ranges.def.includes(ivs.def)
    && ranges.spa.includes(ivs.spa)
    && ranges.spd.includes(ivs.spd)
    && ranges.spe.includes(ivs.spe);
}
