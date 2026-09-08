/**
 * `build` names the procedural mesh recipe in entities/enemy.js.
 * `ai` selects a behaviour profile: 'skittish' | 'aggressive' | 'pack' |
 * 'ranged' | 'ambush' | 'warden'.
 */
export const ENEMIES = {
  boar: {
    id: 'boar', name: 'Boar', build: 'boar', ai: 'skittish', faction: 'beast',
    hp: 30, damage: { blunt: 12 }, armour: 0, stagger: 20,
    speed: 3.2, chaseSpeed: 5.4, aggroRange: 12, attackRange: 1.8, attackCd: 1.8,
    xp: 8, drops: [{ item: 'boar_meat', min: 1, max: 2, chance: 1 },
                   { item: 'leather', min: 1, max: 3, chance: 0.7 }],
    tameable: true, night: false,
  },
  neck: {
    id: 'neck', name: 'Neck', build: 'neck', ai: 'skittish', faction: 'beast',
    hp: 18, damage: { slash: 8 }, armour: 0, stagger: 12,
    speed: 3.6, chaseSpeed: 4.8, aggroRange: 10, attackRange: 1.6, attackCd: 1.5,
    xp: 5, drops: [{ item: 'leather', min: 1, max: 1, chance: 0.5 }],
    water: true,
  },
  greyling: {
    id: 'greyling', name: 'Greyling', build: 'greyfolk', ai: 'aggressive', faction: 'greyfolk',
    hp: 22, damage: { slash: 10 }, armour: 0, stagger: 14,
    speed: 2.8, chaseSpeed: 4.4, aggroRange: 18, attackRange: 2.0, attackCd: 1.6,
    xp: 7, scale: 0.75, drops: [{ item: 'resin', min: 1, max: 2, chance: 0.8 },
                                { item: 'wood', min: 1, max: 2, chance: 0.5 }],
    night: true, fearsFire: true,
  },
  greydwarf: {
    id: 'greydwarf', name: 'Greydwarf', build: 'greyfolk', ai: 'pack', faction: 'greyfolk',
    hp: 48, damage: { slash: 18 }, armour: 2, stagger: 26,
    speed: 3.0, chaseSpeed: 4.8, aggroRange: 22, attackRange: 2.2, attackCd: 1.8,
    xp: 16, drops: [{ item: 'greydwarf_eye', min: 1, max: 2, chance: 0.9 },
                    { item: 'resin', min: 1, max: 2, chance: 0.6 },
                    { item: 'wood', min: 0, max: 2, chance: 0.4 }],
    fearsFire: true,
  },
  draugr: {
    id: 'draugr', name: 'Draugr', build: 'draugr', ai: 'aggressive', faction: 'undead',
    hp: 90, damage: { slash: 32 }, armour: 6, stagger: 44,
    speed: 2.4, chaseSpeed: 4.0, aggroRange: 20, attackRange: 2.4, attackCd: 2.2,
    xp: 40, drops: [{ item: 'leather', min: 1, max: 2, chance: 0.6 }],
  },
  frostwolf: {
    id: 'frostwolf', name: 'Frost Wolf', build: 'wolf', ai: 'pack', faction: 'beast',
    hp: 110, damage: { pierce: 40, frost: 8 }, armour: 4, stagger: 40,
    speed: 4.4, chaseSpeed: 7.2, aggroRange: 28, attackRange: 2.2, attackCd: 1.4,
    xp: 60, drops: [{ item: 'leather', min: 2, max: 4, chance: 1 }],
    night: true,
  },
};

/** Wardens are hand-built encounters; only the first ships in the slice. */
export const WARDENS = {
  hollow_stag: {
    id: 'hollow_stag', name: 'The Hollow Stag', build: 'stag', faction: 'warden',
    hp: 900, armour: 8, stagger: 300, scale: 2.4,
    biome: 'fjaldmark', altarItem: 'boar_meat', altarCount: 2,
    phases: [
      { at: 1.0, moves: ['charge', 'gore'], speed: 5.0 },
      { at: 0.55, moves: ['charge', 'gore', 'lightning'], speed: 6.2, enrage: 1.25 },
    ],
    shard: { id: 'run', name: 'Shard of Running', desc: 'Sprinting costs 25% less stamina.',
             effects: { sprintCostMult: 0.75 } },
    xp: 500, marks: 3,
    drops: [{ item: 'ashen_shard', min: 2, max: 2, chance: 1 }],
  },
};

export const getEnemy = (id) => ENEMIES[id];
