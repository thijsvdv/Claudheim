import { SKILLS, xpForLevel } from '../data/skills.js';
import { VOW_NODES, aggregateEffects } from '../data/vowtree.js';
import { WARDENS } from '../data/enemies.js';

const MAX_LEVEL = 100;
const DEATH_XP_PENALTY = 0.1;   // fraction of in-progress level XP lost on death
const TOTAL_WARDENS = 5;        // VISION section 6; only one ships in the slice

/** Highest level whose cumulative XP threshold `totalXp` has cleared. */
function levelForXp(totalXp) {
  let lvl = 0;
  while (lvl < MAX_LEVEL && totalXp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}

/** Same merge rule vowtree.js uses: Mult keys multiply, other numbers add, rest overwrite. */
function mergeEffectsInto(bag, effects) {
  for (const [k, v] of Object.entries(effects || {})) {
    if (typeof v === 'number' && k.endsWith('Mult')) bag[k] = (bag[k] ?? 1) * v;
    else if (typeof v === 'number') bag[k] = (bag[k] ?? 0) + v;
    else bag[k] = v;
  }
  return bag;
}

export function createProgression(game) {
  const xp = {};      // skillId -> cumulative xp
  const levels = {};  // skillId -> cached level
  const unlocked = new Set();       // Vow-Tree node ids
  const shards = new Map();         // wardenId -> shard def { id, name, desc, effects }
  let oathmarks = 0;
  let effects = {};
  let offDied = null;
  let offWarden = null;

  for (const id of Object.keys(SKILLS)) { xp[id] = 0; levels[id] = 0; }

  function recomputeEffects() {
    const bag = aggregateEffects([...unlocked]);
    for (const shard of shards.values()) mergeEffectsInto(bag, shard.effects);
    effects = bag;
  }

  function setLevel(skillId, level, from) {
    levels[skillId] = level;
    for (let l = from + 1; l <= level; l++) game.bus.emit('player:levelup', { skill: skillId, level: l });
  }

  function onDeath() {
    for (const id of Object.keys(xp)) {
      const base = xpForLevel(levels[id] ?? 0);
      const progressInLevel = xp[id] - base;
      if (progressInLevel > 0) xp[id] -= progressInLevel * DEATH_XP_PENALTY;
    }
  }

  /**
   * `warden:defeated` payload shape isn't fixed by ARCHITECTURE.md; accept a
   * warden id string, `{ id }`/`{ warden }` wrapper, or the warden def itself.
   */
  function onWardenDefeated(payload) {
    const id = typeof payload === 'string' ? payload
      : payload?.id ?? payload?.warden?.id ?? payload?.wardenId;
    if (!id) return;
    const def = payload?.warden ?? (payload && payload.shard ? payload : WARDENS[id]);
    if (def?.shard && !shards.has(id)) shards.set(id, def.shard);
    if (def?.marks) oathmarks += def.marks;
    recomputeEffects();
  }

  const progression = {
    name: 'progression',

    init(g) {
      recomputeEffects();
      offDied = g.bus.on('player:died', onDeath);
      offWarden = g.bus.on('warden:defeated', onWardenDefeated);
    },
    dispose() { offDied?.(); offWarden?.(); },

    gainXp(skillId, amount) {
      if (!(skillId in xp) || !(amount > 0)) return;
      const from = levels[skillId] ?? 0;
      xp[skillId] += amount;
      const next = Math.min(MAX_LEVEL, levelForXp(xp[skillId]));
      if (next > from) setLevel(skillId, next, from);
    },
    level(skillId) { return levels[skillId] ?? 0; },
    has(nodeId) { return unlocked.has(nodeId); },
    /** Extension beyond the hard interface: does the player hold this warden's shard? */
    hasShard(wardenId) { return shards.has(wardenId); },

    get oathmarks() { return oathmarks; },
    get effects() { return effects; },
    get shards() { return [...shards.values()]; },
    get allShardsHeld() { return shards.size >= TOTAL_WARDENS; },

    unlock(nodeId) {
      const node = VOW_NODES[nodeId];
      if (!node || unlocked.has(nodeId)) return false;
      if (oathmarks < node.cost) return false;
      for (const req of node.requires || []) if (!unlocked.has(req)) return false;
      oathmarks -= node.cost;
      unlocked.add(nodeId);
      recomputeEffects();
      return true;
    },

    /** Grave-wisp support: caller (whatever spawns the wisp) drains the marks here. */
    dropMarks() {
      const n = oathmarks;
      oathmarks = 0;
      return n;
    },
    recoverMarks(n) {
      oathmarks += Math.max(0, n | 0);
      return oathmarks;
    },

    serialize() {
      return {
        xp: { ...xp },
        unlocked: [...unlocked],
        oathmarks,
        shards: [...shards.entries()],
      };
    },
    hydrate(data) {
      if (!data) return;
      if (data.xp) for (const [k, v] of Object.entries(data.xp)) if (k in xp) xp[k] = v;
      for (const id of Object.keys(SKILLS)) levels[id] = levelForXp(xp[id] ?? 0);
      unlocked.clear();
      for (const id of data.unlocked || []) if (VOW_NODES[id]) unlocked.add(id);
      shards.clear();
      for (const [id, shard] of data.shards || []) shards.set(id, shard);
      oathmarks = data.oathmarks ?? 0;
      recomputeEffects();
    },
  };

  return progression;
}
