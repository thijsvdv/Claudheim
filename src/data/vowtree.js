/**
 * The Vow-Tree. Nodes cost Oathmarks and are permanent until death-loss rules
 * apply (nodes are never lost; only unspent marks drop).
 *
 * `effects` is a flat bag read by the systems that care:
 *   staminaCostMult, staggerMult, gatherYield, carryMult, blockMult,
 *   parryRiposte(bool), bleed(bool), rageThreshold, eitrMax, regenMult,
 *   buildStability, cookQuality, tameSpeed, runeCostMult, spiritDamage
 */
export const BRANCHES = {
  iron: { id: 'iron', name: 'Iron', subtitle: 'what you will do', colour: '#c9553d' },
  root: { id: 'root', name: 'Root', subtitle: 'what you will keep', colour: '#6f9a4a' },
  rime: { id: 'rime', name: 'Rime', subtitle: 'what you call to witness', colour: '#5b8fb8' },
};

export const VOW_NODES = {
  // ---- IRON ----
  iron_grip:   { id: 'iron_grip', branch: 'iron', tier: 1, cost: 1, requires: [],
                 name: 'Iron Grip', desc: 'Melee attacks cost 12% less stamina.',
                 effects: { staminaCostMult: 0.88 } },
  hard_swing:  { id: 'hard_swing', branch: 'iron', tier: 1, cost: 1, requires: [],
                 name: 'Hard Swing', desc: 'Heavy attacks build 25% more stagger.',
                 effects: { heavyStaggerMult: 1.25 } },
  riposte:     { id: 'riposte', branch: 'iron', tier: 2, cost: 2, requires: ['iron_grip'],
                 name: 'Riposte', desc: 'A parry opens a 1.5s window where your next hit crits for 2x.',
                 effects: { parryRiposte: true } },
  red_thirst:  { id: 'red_thirst', branch: 'iron', tier: 2, cost: 2, requires: ['hard_swing'],
                 name: 'Red Thirst', desc: 'Slashing hits apply bleed: 3 damage/s for 5s.',
                 effects: { bleed: true } },
  last_oath:   { id: 'last_oath', branch: 'iron', tier: 3, cost: 3, requires: ['riposte', 'red_thirst'],
                 name: 'Last Oath', desc: 'Below 30% health you deal 35% more damage and stop staggering.',
                 effects: { rageThreshold: 0.3, rageDamage: 1.35, rageNoStagger: true } },
  // ---- ROOT ----
  deep_roots:  { id: 'deep_roots', branch: 'root', tier: 1, cost: 1, requires: [],
                 name: 'Deep Roots', desc: 'Trees and ore yield 25% more.',
                 effects: { gatherYield: 1.25 } },
  broad_back:  { id: 'broad_back', branch: 'root', tier: 1, cost: 1, requires: [],
                 name: 'Broad Back', desc: 'Carry 30% more weight.',
                 effects: { carryMult: 1.3 } },
  hearthfire:  { id: 'hearthfire', branch: 'root', tier: 2, cost: 2, requires: ['broad_back'],
                 name: 'Hearthfire', desc: 'Rested lasts twice as long; cooked food heals 30% more.',
                 effects: { restedMult: 2, cookQuality: 1.3 } },
  greenhand:   { id: 'greenhand', branch: 'root', tier: 2, cost: 2, requires: ['deep_roots'],
                 name: 'Green Hand', desc: 'Buildings are 40% more stable and cost 15% less.',
                 effects: { buildStability: 1.4, buildCostMult: 0.85 } },
  unbroken:    { id: 'unbroken', branch: 'root', tier: 3, cost: 3, requires: ['hearthfire', 'greenhand'],
                 name: 'Unbroken', desc: 'Stamina regenerates 50% faster and never fully empties.',
                 effects: { regenMult: 1.5, staminaFloor: 8 } },
  // ---- RIME ----
  witness:     { id: 'witness', branch: 'rime', tier: 1, cost: 2, requires: [],
                 name: 'Call a Witness', desc: 'Unlocks Eitr (50) and the rune slot.',
                 effects: { eitrMax: 50 } },
  cold_tongue: { id: 'cold_tongue', branch: 'rime', tier: 1, cost: 1, requires: ['witness'],
                 name: 'Cold Tongue', desc: 'Runes cost 20% less Eitr.',
                 effects: { runeCostMult: 0.8 } },
  emberwright: { id: 'emberwright', branch: 'rime', tier: 2, cost: 2, requires: ['cold_tongue'],
                 name: 'Emberwright', desc: 'Fire and frost runes deal 30% more damage.',
                 effects: { runeDamageMult: 1.3 } },
  second_sight:{ id: 'second_sight', branch: 'rime', tier: 2, cost: 2, requires: ['witness'],
                 name: 'Second Sight', desc: 'Enemies and ore glow faintly through terrain within 30 m.',
                 effects: { sight: 30 } },
  the_vow:     { id: 'the_vow', branch: 'rime', tier: 3, cost: 3, requires: ['emberwright', 'second_sight'],
                 name: 'Speak It Whole', desc: 'On death, spend 20 Eitr to rise where you fell at 30% health. Once per day.',
                 effects: { deathward: true } },
};

export const nodeList = () => Object.values(VOW_NODES);

/** Merge every unlocked node's effects into one bag. */
export function aggregateEffects(unlockedIds) {
  const out = {};
  for (const id of unlockedIds) {
    const node = VOW_NODES[id];
    if (!node) continue;
    for (const [k, v] of Object.entries(node.effects)) {
      if (typeof v === 'number' && k.endsWith('Mult')) out[k] = (out[k] ?? 1) * v;
      else if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
      else out[k] = v;
    }
  }
  return out;
}
