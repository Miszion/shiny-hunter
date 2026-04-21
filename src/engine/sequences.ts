import { ButtonSequence } from '../types';

// === FIRE RED SEQUENCES (FAST TEXT SPEED) ===
// Timings calibrated for normal speed (no turbo) — Switch-compatible

// After BIOS + Game Freak logo (handled by WAIT_BOOT), spam through intro
export const FIRE_RED_TITLE_SCREEN: ButtonSequence = [
  // Use A to skip intro sequences, then START on title screen.
  // Slower interval (350ms) to avoid overshooting past CONTINUE in the menu.
  { action: 'mashA', count: 8, intervalMs: 350 },
  // START presses to hit "PRESS START" on title screen
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 300 },
];

// Select CONTINUE from the menu
export const FIRE_RED_LOAD_SAVE: ButtonSequence = [
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 2000 },
];

// Pick starter from pokeball (FAST TEXT) — works for all 3 starters
// Timing-sensitive — nickname prompt timing must not be shortened
export const FIRE_RED_STARTER_PICK: ButtonSequence = [
  // Phase 1: Dialogue + YES + animation starts
  // Fast text: A4 selects YES (~t=2.4s), animation runs during remaining A's
  { action: 'mashA', count: 7, intervalMs: 800 },

  // Phase 2: Wait for fanfare + nickname prompt
  // YES at ~t=2.4s, nickname ~7s after YES. mashA ends at t=5.6s → need ~4s
  { action: 'wait', ms: 2000 },

  // Phase 3: Decline nickname (B spam — harmless if fanfare still going)
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Phase 4: Rival dialogue + pick — enough A to clear text, then move on
  { action: 'mashA', count: 5, intervalMs: 200 },
  { action: 'wait', ms: 1500 },
  { action: 'mashA', count: 8, intervalMs: 200 },
  { action: 'wait', ms: 200 },
];

// Open Party → Summary (tightened where safe, generous final wait for screen render)
export const FIRE_RED_OPEN_SUMMARY: ButtonSequence = [
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // POKéMON (first option)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },
  // Select starter
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // SUMMARY
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 500 },
  // Safety A — then wait for summary screen to fully render + clear shiny verify
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 1300 },
];

// === LAPRAS GIFT SEQUENCE (Silph Co 7F) ===
// Pre-condition: saved in front of the Silph Co employee who gives Lapras.
// Must have already beaten rival on this floor.
//
// Dialogue from pokefirered decomp:
// 1. "Oh! Hi! You're not a ROCKET! You came to save us? Why, thank you!"  (A, A)
// 2. "I want you to have this POKéMON for saving us."  (A)
// 3. [givemon LAPRAS Lv25]
// 4. "[PLAYER] obtained a LAPRAS from the SILPH employee!" + fanfare (~3s)
// 5. "Would you like to give a nickname?" → B (NO)
// 6. "It's a LAPRAS. It's a very intelligent POKéMON..." (A×4 explanation text)
// 7. [setflag] done

export const FRLG_LAPRAS_INTERACT: ButtonSequence = [
  // Phase 1: Talk to NPC — 3 text boxes before receiving the gift.
  { action: 'mashA', count: 5, intervalMs: 800 },

  // Phase 2: "[PLAYER] obtained a LAPRAS!" + fanfare jingle.
  { action: 'wait', ms: 3000 },

  // Phase 3: nickname prompt → decline.
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Phase 4: post-nickname explanation text (4 text boxes).
  { action: 'mashA', count: 6, intervalMs: 800 },

  // Wait for dialogue to fully close.
  { action: 'wait', ms: 500 },
];

// === STATIC LEGENDARY ENCOUNTER SEQUENCE ===
// Pre-condition: player saved directly in front of (and facing) the legendary.
//   - Articuno: Seafoam Islands B4F
//   - Zapdos: Power Plant
//   - Moltres: Mt. Ember summit
//   - Mewtwo: Cerulean Cave B1F
//
// Flow: single A press triggers the "Wild XXX appeared!" battle. PID is
// generated at encounter-trigger time, so the advance count from title-press
// to PID is short and narrow (≈100-200 wide vs ≈5,000 for Lapras gift).
//
// We DO NOT catch the legendary during hunting — we soft-reset on non-shiny.
// The LegendaryHuntEngine uses battle-shiny.ts sparkle detection to read the
// result without committing to the fight.

export const FRLG_LEGENDARY_INTERACT: ButtonSequence = [
  // Legendaries in FRLG require multiple A presses: first press triggers
  // the cry/approach animation and a short dialog ("Gyaoo!" etc.) with
  // the player still in overworld; subsequent A presses dismiss that
  // dialog and initiate the battle proper. Empirically 4 A presses with
  // ~800ms spacing engages reliably on Articuno/Zapdos/Moltres/Mewtwo.
  { action: 'mashA', count: 4, intervalMs: 800 },
];

// === FOSSIL REVIVAL SEQUENCES (Cinnabar Lab) ===
// Pre-condition: saved in front of scientist AFTER giving fossil.
// Talk to scientist → receive revived Pokemon → decline nickname.

export const FRLG_FOSSIL_INTERACT: ButtonSequence = [
  // Phase 1: Talk to scientist and advance through dialogue
  // "Ah, [PLAYER]!" / "Your fossil Pokemon is fully restored!" / "Here, take it back!"
  // Fast text: each text box = 1 A press. Be generous (6 presses).
  { action: 'mashA', count: 6, intervalMs: 800 },

  // Phase 2: "[Player] received [POKEMON]!" + fanfare jingle (~3s)
  // Extra A presses during fanfare are harmless.
  { action: 'wait', ms: 3000 },

  // Phase 3: "Would you like to give a nickname?" → NO
  // B spam declines the nickname prompt
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Small wait for dialogue to fully close
  { action: 'wait', ms: 500 },
];

// Open summary for a non-first party slot.
// Navigates DOWN to reach the target slot before selecting SUMMARY.
// The number of DOWN presses is controlled by the engine based on PARTY_SLOT config.
// This sequence handles slot 1 (no DOWN needed).
export const FIRE_RED_OPEN_SUMMARY_SLOT1: ButtonSequence = [
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // POKéMON (first option)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },
  // Select Pokemon in slot
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // SUMMARY
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 500 },
  // Safety A + wait for summary screen render
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 1300 },
];

// === GAME CORNER PRIZE SEQUENCE (Celadon City) ===
// Pre-condition: saved in front of the Game Corner prize counter.
// Must have enough coins for the prize (Dratini = 2800 in LG, 4600 in FR).
//
// FRLG prize counter flow:
// 1. Talk to clerk → "Welcome! Would you like a prize?"  (A)
// 2. Prize list appears (Dratini is a listed option) → select it (A)
// 3. "A DRATINI, is that right?" → YES (A)
// 4. "[PLAYER] received a DRATINI!" + fanfare jingle (~3s)
// 5. "Would you like to give a nickname?" → B (NO)
// 6. Post-text — may return to prize list, press B to exit

export const FRLG_CASINO_PRIZE: ButtonSequence = [
  // Phase 1: Talk to clerk → "Want a prize?" → YES (default)
  { action: 'press', keys: ['A'], holdMs: 50 },   // Initiate conversation
  { action: 'wait', ms: 1000 },
  { action: 'press', keys: ['A'], holdMs: 50 },   // Advance dialogue / select YES
  { action: 'wait', ms: 1000 },                   // Wait for prize list to render

  // Phase 2: Navigate DOWN to Dratini (3 DOWNs: ABRA → CLEFAIRY → PINSIR → DRATINI)
  { action: 'press', keys: ['DOWN'], holdMs: 100 },
  { action: 'wait', ms: 300 },
  { action: 'press', keys: ['DOWN'], holdMs: 100 },
  { action: 'wait', ms: 300 },
  { action: 'press', keys: ['DOWN'], holdMs: 100 },
  { action: 'wait', ms: 400 },

  // Phase 3: Select Dratini → "So, you want the DRATINI?" YES/NO
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 1000 },

  // Phase 4: Confirm YES. Double-tap for reliability.
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 350 },
  { action: 'press', keys: ['A'], holdMs: 50 },

  // Phase 5: Wait for purchase + fanfare (~2.8s)
  { action: 'wait', ms: 2800 },

  // Phase 6: B spam — decline nickname + exit
  { action: 'mashB', count: 7, intervalMs: 280 },
];

// === EEVEE GIFT SEQUENCE (Celadon Condominiums rooftop) ===
// Pre-condition: saved in front of the Pokeball on the table in the back
// entrance rooftop room of Celadon Condominiums.
//
// Flow:
// 1. A on Pokeball → "There's a POKé BALL on the desk. It contains EEVEE. Take it?"
// 2. YES (default) → A
// 3. "[PLAYER] received EEVEE!" + fanfare (~3s)
// 4. "Would you like to give a nickname?" → B (NO)

export const FRLG_EEVEE_INTERACT: ButtonSequence = [
  // Phase 1: Interact with Pokeball
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 800 },

  // Phase 2: "Take it?" -> YES (A-spam)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 300 },
  { action: 'press', keys: ['A'], holdMs: 50 },

  // Phase 3: Receive + fanfare (tightened)
  { action: 'wait', ms: 2500 },

  // Phase 4: Decline nickname (rapid B)
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 250 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 250 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 250 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 250 },

  // Dialogue close
  { action: 'wait', ms: 300 },
];

// Map of game → starter → sequences
export const SEQUENCES: Record<string, Record<string, {
  title: ButtonSequence;
  loadSave: ButtonSequence;
  pick: ButtonSequence;
  summary: ButtonSequence;
}>> = {
  'fire-red': {
    charmander: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    squirtle: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    bulbasaur: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
  'leaf-green': {
    charmander: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    squirtle: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    bulbasaur: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
};

// Static encounter sequences keyed by game → pokemon
// Used by StaticHuntEngine for fossil revival, gift Pokemon, etc.
export const STATIC_SEQUENCES: Record<string, Record<string, {
  title: ButtonSequence;
  loadSave: ButtonSequence;
  interact: ButtonSequence;
  summary: ButtonSequence;
}>> = {
  'fire-red': {
    // Casino prize (Celadon Game Corner — Lv18 in FR)
    dratini: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_CASINO_PRIZE,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Gift Pokemon (Silph Co 7F — Lv25)
    lapras: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LAPRAS_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Gift Pokemon (Celadon Condominiums rooftop — Lv25)
    eevee: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_EEVEE_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Fossil Pokemon (Cinnabar Lab — Lv5)
    aerodactyl: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    kabuto: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    omanyte: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Stationary legendary encounters — interact triggers a wild battle at Lv50
    // (Mewtwo Lv70). `summary` sequence is unused for the legendary hunt path
    // (LegendaryHuntEngine reads shiny-ness via battle sparkle, not summary).
    articuno: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    zapdos: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    moltres: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    mewtwo: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
  'leaf-green': {
    dratini: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_CASINO_PRIZE,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    lapras: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LAPRAS_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    eevee: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_EEVEE_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    aerodactyl: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    kabuto: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    omanyte: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Stationary legendary encounters — interact triggers a wild battle at Lv50
    // (Mewtwo Lv70). `summary` sequence is unused for the legendary hunt path
    // (LegendaryHuntEngine reads shiny-ness via battle sparkle, not summary).
    articuno: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    zapdos: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    moltres: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    mewtwo: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LEGENDARY_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
};

export function getStaticSequences(game: string, target: string) {
  const gameSeqs = STATIC_SEQUENCES[game];
  if (!gameSeqs) throw new Error(`No static sequences defined for game: ${game}`);
  const seq = gameSeqs[target.toLowerCase()];
  if (!seq) throw new Error(`No static sequences defined for ${target} in ${game}`);
  return seq;
}

export function getSequences(game: string, target: string) {
  const gameSeqs = SEQUENCES[game];
  if (!gameSeqs) throw new Error(`No sequences defined for game: ${game}`);
  const seq = gameSeqs[target.toLowerCase()];
  if (!seq) throw new Error(`No sequences defined for ${target} in ${game}`);
  return seq;
}
