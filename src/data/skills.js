/**
 * Proficiencies rise by use and cannot be allocated. Levels are 0..100.
 * XP curve is deliberately slow at the top so 100 is a long-run goal.
 */
export const SKILLS = {
  swords:   { id: 'swords', name: 'Swords', group: 'iron' },
  axes:     { id: 'axes', name: 'Axes', group: 'iron' },
  clubs:    { id: 'clubs', name: 'Clubs', group: 'iron' },
  spears:   { id: 'spears', name: 'Spears', group: 'iron' },
  bows:     { id: 'bows', name: 'Bows', group: 'iron' },
  unarmed:  { id: 'unarmed', name: 'Unarmed', group: 'iron' },
  blocking: { id: 'blocking', name: 'Blocking', group: 'iron' },
  pickaxes: { id: 'pickaxes', name: 'Pickaxes', group: 'root' },
  woodcut:  { id: 'woodcut', name: 'Woodcutting', group: 'root' },
  running:  { id: 'running', name: 'Running', group: 'root' },
  jumping:  { id: 'jumping', name: 'Jumping', group: 'root' },
  swimming: { id: 'swimming', name: 'Swimming', group: 'root' },
  building: { id: 'building', name: 'Building', group: 'root' },
  cooking:  { id: 'cooking', name: 'Cooking', group: 'root' },
  seidr:    { id: 'seidr', name: 'Seidr', group: 'rime' },
};

/** Total XP required to reach `level`. */
export const xpForLevel = (level) => Math.round(Math.pow(level, 1.65) * 6.2);

/** Damage/efficiency multiplier a proficiency level grants. */
export const skillBonus = (level) => 1 + (level / 100) * 0.75;
/** Stamina cost multiplier — high proficiency is markedly cheaper. */
export const skillStaminaMult = (level) => 1 - (level / 100) * 0.4;
