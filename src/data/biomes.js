/**
 * Biomes are assigned by distance-from-origin ring + a warped noise mask, so a
 * seed fully determines the map. `ring` is the nominal radius band in metres.
 */
export const BIOMES = {
  ocean: {
    id: 'ocean', name: 'The Grey', ring: [520, Infinity],
    ground: 0x2c3a44, sand: 0x8a7f6a, fog: 0x8ba0ad, fogDensity: 0.008,
    grass: null, treeDensity: 0, danger: 1,
  },
  shore: {
    id: 'shore', name: 'Strand', ring: [0, Infinity],
    ground: 0xb3a480, sand: 0xc2b48c, fog: 0xbfd0d8, fogDensity: 0.0045,
    grass: 0x9aa36a, treeDensity: 0.02, danger: 1,
  },
  fjaldmark: {
    id: 'fjaldmark', name: 'Fjaldmark', ring: [0, 180],
    ground: 0x5c7a3a, sand: 0xb3a480, fog: 0xc8d8e0, fogDensity: 0.0035,
    grass: 0x7fa04a, treeDensity: 0.35, danger: 1,
    spawns: ['boar', 'neck', 'greyling'],
  },
  myrkvid: {
    id: 'myrkvid', name: 'Myrkvid', ring: [180, 340],
    ground: 0x33482c, sand: 0x4a4436, fog: 0x5a6b58, fogDensity: 0.011,
    grass: 0x3e5a30, treeDensity: 0.9, danger: 2,
    spawns: ['greydwarf', 'greyling', 'boar'],
  },
  mire: {
    id: 'mire', name: 'The Mire', ring: [300, 440],
    ground: 0x3d3524, sand: 0x2e2a1c, fog: 0x6b6046, fogDensity: 0.02,
    grass: 0x4a4526, treeDensity: 0.45, danger: 3,
    spawns: ['draugr', 'leech'],
  },
  frostreach: {
    id: 'frostreach', name: 'Frostreach', ring: [340, 520],
    ground: 0xdfe8ef, sand: 0x6b7076, fog: 0xd8e4ee, fogDensity: 0.018,
    grass: null, treeDensity: 0.12, danger: 4,
    spawns: ['frostwolf'], cold: true,
  },
  ashwake: {
    id: 'ashwake', name: 'The Ashwake', ring: [0, 60],
    ground: 0x4a4340, sand: 0x5c5450, fog: 0x8a7a72, fogDensity: 0.016,
    grass: null, treeDensity: 0.05, danger: 5,
    spawns: [],
  },
};

export const BIOME_IDS = Object.keys(BIOMES);
export const getBiome = (id) => BIOMES[id] || BIOMES.fjaldmark;
