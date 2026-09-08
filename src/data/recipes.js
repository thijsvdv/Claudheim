/**
 * station: null (anywhere) | 'workbench' | 'forge' | 'campfire'
 * Cooking recipes use the campfire and take real time.
 */
export const RECIPES = [
  { id: 'stone_axe', out: { stone_axe: 1 }, cost: { wood: 5, stone: 4 }, station: null },
  { id: 'club', out: { club: 1 }, cost: { wood: 8 }, station: null },
  { id: 'hammer', out: { hammer: 1 }, cost: { wood: 3, stone: 2 }, station: null },
  { id: 'torch', out: { torch: 1 }, cost: { wood: 2, resin: 1 }, station: null },
  { id: 'pickaxe', out: { pickaxe: 1 }, cost: { wood: 10, ashen_shard: 1 }, station: 'workbench' },
  { id: 'flint_spear', out: { flint_spear: 1 }, cost: { wood: 10, flint: 6, leather: 2 }, station: 'workbench' },
  { id: 'wood_shield', out: { wood_shield: 1 }, cost: { wood: 12, resin: 4 }, station: 'workbench' },
  { id: 'crude_bow', out: { crude_bow: 1 }, cost: { wood: 10, leather: 8 }, station: 'workbench' },
  { id: 'wood_arrow', out: { wood_arrow: 20 }, cost: { wood: 8, feather: 2, flint: 2 }, station: 'workbench' },
  { id: 'copper_bar', out: { copper_bar: 1 }, cost: { copper_ore: 2 }, station: 'forge', time: 4 },
  { id: 'bronze_bar', out: { bronze_bar: 1 }, cost: { copper_bar: 2, tin_ore: 1 }, station: 'forge', time: 6 },
  { id: 'bronze_sword', out: { bronze_sword: 1 }, cost: { bronze_bar: 8, wood: 2, leather: 3 }, station: 'forge' },
  { id: 'bronze_mace', out: { bronze_mace: 1 }, cost: { bronze_bar: 10, corewood: 4 }, station: 'forge' },
  { id: 'rune_ember', out: { rune_ember: 1 }, cost: { greydwarf_eye: 10, resin: 8, ashen_shard: 1 }, station: 'workbench' },
  { id: 'rune_frost', out: { rune_frost: 1 }, cost: { greydwarf_eye: 16, flint: 10, ashen_shard: 1 }, station: 'workbench' },
  { id: 'cooked_meat', out: { cooked_meat: 1 }, cost: { boar_meat: 1 }, station: 'campfire', time: 20, skill: 'cooking' },
];

/**
 * Buildable pieces. `snap` describes grid alignment; `integrity` is how far
 * load can travel through this piece before a structure sags and collapses.
 */
export const BUILD_PIECES = [
  { id: 'wood_floor', name: 'Wood Floor', cost: { wood: 2 }, size: [2, 0.2, 2], integrity: 0.7, material: 'wood', support: true },
  { id: 'wood_wall', name: 'Wood Wall', cost: { wood: 2 }, size: [2, 2, 0.2], integrity: 0.75, material: 'wood', support: true },
  { id: 'wood_beam', name: 'Wood Beam', cost: { wood: 1 }, size: [0.25, 2, 0.25], integrity: 0.9, material: 'wood', support: true },
  { id: 'wood_stairs', name: 'Wood Stairs', cost: { wood: 3 }, size: [2, 2, 2], integrity: 0.65, material: 'wood', support: true, stairs: true },
  { id: 'wood_roof', name: 'Thatch Roof', cost: { wood: 2 }, size: [2, 0.2, 2], integrity: 0.5, material: 'wood', slope: 30 },
  { id: 'wood_door', name: 'Wood Door', cost: { wood: 4 }, size: [1.6, 2, 0.2], integrity: 0.5, material: 'wood', door: true },
  { id: 'workbench', name: 'Workbench', cost: { wood: 10 }, size: [2, 1, 1], station: 'workbench', radius: 12 },
  { id: 'campfire', name: 'Campfire', cost: { stone: 5, wood: 2 }, size: [1.2, 0.5, 1.2], station: 'campfire', radius: 4, light: true, fire: true },
  { id: 'forge', name: 'Forge', cost: { stone: 4, copper_bar: 4, wood: 10 }, size: [2, 1.6, 2], station: 'forge', radius: 12 },
  { id: 'hearth', name: 'Ember Hearth', cost: { stone: 16, wood: 8, ashen_shard: 1 }, size: [2, 1.4, 2], radius: 20, bindsSpawn: true, light: true },
];

export const getPiece = (id) => BUILD_PIECES.find((p) => p.id === id);
