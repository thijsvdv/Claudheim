/**
 * kind: 'resource' | 'food' | 'weapon' | 'tool' | 'armour' | 'build' | 'rune' | 'trophy'
 * Weapons and tools carry a `weapon` key pointing into data/weapons.js.
 */
export const ITEMS = {
  // --- raw resources ---
  wood:        { id: 'wood', name: 'Wood', kind: 'resource', stack: 50, weight: 2, colour: 0x8a6238 },
  corewood:    { id: 'corewood', name: 'Core Wood', kind: 'resource', stack: 50, weight: 3, colour: 0x5e4426 },
  stone:       { id: 'stone', name: 'Stone', kind: 'resource', stack: 50, weight: 3, colour: 0x8d8d8d },
  flint:       { id: 'flint', name: 'Flint', kind: 'resource', stack: 50, weight: 1, colour: 0x4a4a52 },
  resin:       { id: 'resin', name: 'Resin', kind: 'resource', stack: 50, weight: 0.3, colour: 0xd9a441 },
  leather:     { id: 'leather', name: 'Leather Scraps', kind: 'resource', stack: 50, weight: 0.5, colour: 0x9c6b3f },
  feather:     { id: 'feather', name: 'Feathers', kind: 'resource', stack: 50, weight: 0.1, colour: 0xe4e0d6 },
  copper_ore:  { id: 'copper_ore', name: 'Copper Ore', kind: 'resource', stack: 30, weight: 8, colour: 0xb87333 },
  tin_ore:     { id: 'tin_ore', name: 'Tin Ore', kind: 'resource', stack: 30, weight: 8, colour: 0xa8b0b8 },
  copper_bar:  { id: 'copper_bar', name: 'Copper Bar', kind: 'resource', stack: 30, weight: 6, colour: 0xd08a4a },
  bronze_bar:  { id: 'bronze_bar', name: 'Bronze Bar', kind: 'resource', stack: 30, weight: 6, colour: 0xc08b45 },
  greydwarf_eye:{ id: 'greydwarf_eye', name: 'Greydwarf Eye', kind: 'resource', stack: 50, weight: 0.2, colour: 0xc9d8b0 },
  ashen_shard: { id: 'ashen_shard', name: 'Ashen Shard', kind: 'trophy', stack: 5, weight: 1, colour: 0xff8c42 },
  // --- food ---
  raspberries: { id: 'raspberries', name: 'Raspberries', kind: 'food', stack: 50, weight: 0.1,
                 food: { hp: 8, stam: 20, duration: 600, regen: 1 }, colour: 0xc8385c },
  mushroom:    { id: 'mushroom', name: 'Mushroom', kind: 'food', stack: 50, weight: 0.1,
                 food: { hp: 10, stam: 15, duration: 600, regen: 1 }, colour: 0xd9c9a8 },
  boar_meat:   { id: 'boar_meat', name: 'Raw Boar', kind: 'food', stack: 20, weight: 1,
                 food: { hp: 15, stam: 10, duration: 600, regen: 1 }, colour: 0xb45c5c },
  cooked_meat: { id: 'cooked_meat', name: 'Cooked Boar', kind: 'food', stack: 20, weight: 1,
                 food: { hp: 35, stam: 25, duration: 1200, regen: 3 }, colour: 0x8a5230 },
  honey:       { id: 'honey', name: 'Honey', kind: 'food', stack: 50, weight: 0.2,
                 food: { hp: 20, stam: 30, duration: 900, regen: 2 }, colour: 0xe0a020 },
  // --- tools & weapons (see weapons.js) ---
  stone_axe:   { id: 'stone_axe', name: 'Stone Axe', kind: 'tool', stack: 1, weight: 4, weapon: 'stone_axe' },
  pickaxe:     { id: 'pickaxe', name: 'Antler Pickaxe', kind: 'tool', stack: 1, weight: 5, weapon: 'pickaxe' },
  club:        { id: 'club', name: 'Club', kind: 'weapon', stack: 1, weight: 3, weapon: 'club' },
  flint_spear: { id: 'flint_spear', name: 'Flint Spear', kind: 'weapon', stack: 1, weight: 3, weapon: 'flint_spear' },
  bronze_sword:{ id: 'bronze_sword', name: 'Bronze Sword', kind: 'weapon', stack: 1, weight: 5, weapon: 'bronze_sword' },
  bronze_mace: { id: 'bronze_mace', name: 'Bronze Mace', kind: 'weapon', stack: 1, weight: 7, weapon: 'bronze_mace' },
  crude_bow:   { id: 'crude_bow', name: 'Crude Bow', kind: 'weapon', stack: 1, weight: 3, weapon: 'crude_bow' },
  wood_arrow:  { id: 'wood_arrow', name: 'Wood Arrow', kind: 'ammo', stack: 100, weight: 0.1, colour: 0x9a7c4a },
  wood_shield: { id: 'wood_shield', name: 'Wood Shield', kind: 'shield', stack: 1, weight: 6,
                 block: { armour: 12, parryBonus: 1.5, staminaMult: 1 } },
  torch:       { id: 'torch', name: 'Torch', kind: 'weapon', stack: 1, weight: 1, weapon: 'torch', light: true },
  // --- runes (Rime branch) ---
  rune_ember:  { id: 'rune_ember', name: 'Rune: Ember', kind: 'rune', stack: 1, weight: 1,
                 rune: { eitr: 20, damage: 34, type: 'fire', cast: 0.8, range: 26 } },
  rune_frost:  { id: 'rune_frost', name: 'Rune: Rime', kind: 'rune', stack: 1, weight: 1,
                 rune: { eitr: 26, damage: 22, type: 'frost', cast: 1.1, range: 20, slow: 0.5 } },
  // --- building ---
  hammer:      { id: 'hammer', name: 'Hammer', kind: 'tool', stack: 1, weight: 2, weapon: 'hammer', builder: true },
};

export const getItem = (id) => ITEMS[id];
export const isStackable = (id) => (ITEMS[id]?.stack ?? 1) > 1;
