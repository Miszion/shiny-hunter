/**
 * Debug: print all possible stat values for Dratini at Lv24, Serious nature.
 * This helps us verify what we're reading from the screenshot.
 */

// Dratini base stats
const base = { hp: 41, atk: 64, def: 45, spa: 50, spd: 50, spe: 50 };

function calcHP(baseHP: number, iv: number, level: number): number {
  return Math.floor((2 * baseHP + iv) * level / 100) + level + 10;
}

function calcStat(baseStat: number, iv: number, level: number, natureMod: number): number {
  return Math.floor((Math.floor((2 * baseStat + iv) * level / 100) + 5) * natureMod);
}

const level = 24;
// Serious = neutral (all mods are 1.0)
const natureMod = 1.0;

console.log('All possible Dratini stats at Lv24, Serious nature, 0 EVs:\n');

console.log('IV | HP  | ATK | DEF | SPA | SPD | SPE');
console.log('---|-----|-----|-----|-----|-----|----');
for (let iv = 0; iv <= 31; iv++) {
  const hp = calcHP(base.hp, iv, level);
  const atk = calcStat(base.atk, iv, level, natureMod);
  const def = calcStat(base.def, iv, level, natureMod);
  const spa = calcStat(base.spa, iv, level, natureMod);
  const spd = calcStat(base.spd, iv, level, natureMod);
  const spe = calcStat(base.spe, iv, level, natureMod);
  console.log(`${String(iv).padStart(2)} | ${String(hp).padStart(3)} | ${String(atk).padStart(3)} | ${String(def).padStart(3)} | ${String(spa).padStart(3)} | ${String(spd).padStart(3)} | ${String(spe).padStart(3)}`);
}

console.log('\nPossible stat values:');
const hpVals = new Set<number>();
const atkVals = new Set<number>();
const defVals = new Set<number>();
const spaVals = new Set<number>();
const spdVals = new Set<number>();
const speVals = new Set<number>();
for (let iv = 0; iv <= 31; iv++) {
  hpVals.add(calcHP(base.hp, iv, level));
  atkVals.add(calcStat(base.atk, iv, level, natureMod));
  defVals.add(calcStat(base.def, iv, level, natureMod));
  spaVals.add(calcStat(base.spa, iv, level, natureMod));
  spdVals.add(calcStat(base.spd, iv, level, natureMod));
  speVals.add(calcStat(base.spe, iv, level, natureMod));
}
console.log(`HP:  ${[...hpVals].sort((a,b)=>a-b).join(', ')}`);
console.log(`ATK: ${[...atkVals].sort((a,b)=>a-b).join(', ')}`);
console.log(`DEF: ${[...defVals].sort((a,b)=>a-b).join(', ')}`);
console.log(`SPA: ${[...spaVals].sort((a,b)=>a-b).join(', ')}`);
console.log(`SPD: ${[...spdVals].sort((a,b)=>a-b).join(', ')}`);
console.log(`SPE: ${[...speVals].sort((a,b)=>a-b).join(', ')}`);
