/**
 * A moveset is what gives a weapon class identity. Each entry describes the
 * timing of one attack: windup (no hitbox), active (hitbox open), recover.
 * `arc` is the horizontal sweep in radians, `reach` in metres.
 *
 * skill: which proficiency this trains (see data/skills.js)
 * toolTier: what world resources it can harvest (0 = none)
 */
const swing = (o) => ({ windup: 0.18, active: 0.1, recover: 0.28, arc: 1.6, reach: 2.4, ...o });

export const WEAPONS = {
  fists: {
    id: 'fists', name: 'Fists', skill: 'unarmed', class: 'unarmed',
    damage: { blunt: 6 }, stagger: 6, stamina: 6, knockback: 1,
    light: [swing({ arc: 0.9, reach: 1.6 })],
    heavy: swing({ windup: 0.34, arc: 1.0, reach: 1.8 }),
  },
  stone_axe: {
    id: 'stone_axe', name: 'Stone Axe', skill: 'axes', class: 'axe',
    damage: { slash: 18 }, stagger: 16, stamina: 12, knockback: 2,
    tool: { chop: 1 }, toolTier: 1,
    light: [swing({ arc: 1.7 }), swing({ arc: 1.9, windup: 0.14 }), swing({ arc: 2.1, recover: 0.4 })],
    heavy: swing({ windup: 0.45, active: 0.14, recover: 0.5, arc: 2.4, reach: 2.7,
                   damageMult: 1.9, staggerMult: 2.4, staminaMult: 2 }),
  },
  pickaxe: {
    id: 'pickaxe', name: 'Antler Pickaxe', skill: 'pickaxes', class: 'pick',
    damage: { pierce: 12 }, stagger: 20, stamina: 14, knockback: 1,
    tool: { mine: 1 }, toolTier: 1,
    light: [swing({ arc: 0.7, reach: 2.2, windup: 0.3, recover: 0.4 })],
    heavy: swing({ windup: 0.5, arc: 0.8, reach: 2.3, damageMult: 1.6, staggerMult: 2 }),
  },
  club: {
    id: 'club', name: 'Club', skill: 'clubs', class: 'mace',
    damage: { blunt: 22 }, stagger: 34, stamina: 14, knockback: 4,
    light: [swing({ arc: 1.5 }), swing({ arc: 1.7, windup: 0.22 })],
    heavy: swing({ windup: 0.5, active: 0.14, recover: 0.55, arc: 1.9,
                   damageMult: 1.8, staggerMult: 2.6, staminaMult: 2.1, knockbackMult: 2 }),
  },
  flint_spear: {
    id: 'flint_spear', name: 'Flint Spear', skill: 'spears', class: 'spear',
    damage: { pierce: 24 }, stagger: 14, stamina: 10, knockback: 2,
    throwable: true,
    light: [swing({ arc: 0.45, reach: 3.4, windup: 0.14, active: 0.09, recover: 0.24 }),
            swing({ arc: 0.45, reach: 3.6, windup: 0.12, recover: 0.3 })],
    heavy: swing({ windup: 0.4, arc: 0.5, reach: 4.0, damageMult: 1.7, staggerMult: 1.6 }),
  },
  bronze_sword: {
    id: 'bronze_sword', name: 'Bronze Sword', skill: 'swords', class: 'sword',
    damage: { slash: 34 }, stagger: 22, stamina: 11, knockback: 2,
    light: [swing({ windup: 0.13, active: 0.09, recover: 0.2, arc: 1.5 }),
            swing({ windup: 0.11, active: 0.09, recover: 0.22, arc: 1.7 }),
            swing({ windup: 0.12, active: 0.1, recover: 0.34, arc: 0.5, reach: 2.9, damageMult: 1.3 })],
    heavy: swing({ windup: 0.42, active: 0.13, recover: 0.42, arc: 2.0,
                   damageMult: 1.7, staggerMult: 2.2, staminaMult: 1.9 }),
  },
  bronze_mace: {
    id: 'bronze_mace', name: 'Bronze Mace', skill: 'clubs', class: 'mace',
    damage: { blunt: 40 }, stagger: 52, stamina: 18, knockback: 5,
    armourPierce: 0.5,
    light: [swing({ windup: 0.26, recover: 0.38, arc: 1.5 }), swing({ windup: 0.28, arc: 1.8 })],
    heavy: swing({ windup: 0.62, active: 0.16, recover: 0.6, arc: 2.0,
                   damageMult: 2.0, staggerMult: 2.8, staminaMult: 2.2, knockbackMult: 2.2 }),
  },
  crude_bow: {
    id: 'crude_bow', name: 'Crude Bow', skill: 'bows', class: 'bow',
    damage: { pierce: 26 }, stagger: 10, stamina: 6, knockback: 1,
    ranged: { drawTime: 0.7, drainPerSec: 12, speed: 48, headshot: 2.5, ammo: 'wood_arrow' },
    light: [], heavy: null,
  },
  torch: {
    id: 'torch', name: 'Torch', skill: 'clubs', class: 'torch',
    damage: { blunt: 5, fire: 12 }, stagger: 8, stamina: 8, knockback: 1,
    light: [swing({ arc: 1.2, reach: 2.0 })], heavy: null,
  },
  hammer: {
    id: 'hammer', name: 'Hammer', skill: 'clubs', class: 'builder',
    damage: { blunt: 4 }, stagger: 4, stamina: 5, knockback: 0,
    light: [swing({ arc: 0.8, reach: 1.8 })], heavy: null,
  },
};

export const getWeapon = (id) => WEAPONS[id] || WEAPONS.fists;

/** Block/parry timing shared by all shields. */
export const BLOCK = { parryWindow: 0.18, parryStaggerMult: 2.0, chipRatio: 0.15 };
