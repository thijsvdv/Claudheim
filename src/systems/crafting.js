import { RECIPES } from '../data/recipes.js';

/**
 * Crafting checks resources + nearby stations and, for timed recipes (smelting,
 * cooking), queues the job on the station itself so multiple stations can cook
 * independently and a queue survives a save/reload.
 */
export function createCrafting(game) {
  // stationId -> [{ recipeId, remaining, total }], 'global' for timed recipes with station:null
  const queues = new Map();

  const getRecipe = (id) => RECIPES.find((r) => r.id === id);

  /** Nearest placed station of `kind` within its own radius, or null. */
  function nearestStation(kind) {
    const stations = game.building?.stations;
    const pos = game.player?.position;
    if (!stations || !pos) return null;
    let best = null;
    let bestD = Infinity;
    for (const st of stations) {
      if (st.kind !== kind) continue;
      const d = st.position.distanceToSquared(pos);
      if (d <= st.radius * st.radius && d < bestD) { bestD = d; best = st; }
    }
    return best;
  }

  function canCraft(recipeId) {
    const r = getRecipe(recipeId);
    if (!r) return { ok: false, missing: ['unknown-recipe'] };
    const missing = [];
    if (r.station && !nearestStation(r.station)) missing.push(`station:${r.station}`);
    for (const [id, need] of Object.entries(r.cost)) {
      const have = game.inventory?.count(id) ?? 0;
      if (have < need) missing.push(id);
    }
    return { ok: missing.length === 0, missing };
  }

  function completeRecipe(r) {
    for (const [id, amount] of Object.entries(r.out)) game.inventory?.add(id, amount);
    if (r.skill) game.progression?.gainXp(r.skill, r.time ?? 5);
    game.bus.emit('craft:completed', { id: r.id, out: r.out });
  }

  function craft(recipeId) {
    const r = getRecipe(recipeId);
    if (!r) return false;
    const { ok } = canCraft(recipeId);
    if (!ok) return false;

    for (const [id, need] of Object.entries(r.cost)) game.inventory.remove(id, need);

    if (r.time) {
      const station = r.station ? nearestStation(r.station) : null;
      const key = station ? station.id : 'global';
      const q = queues.get(key) ?? [];
      q.push({ recipeId: r.id, remaining: r.time, total: r.time });
      queues.set(key, q);
    } else {
      completeRecipe(r);
    }
    return true;
  }

  function available() {
    return RECIPES.filter((r) => !r.station || nearestStation(r.station));
  }

  return {
    name: 'crafting',
    canCraft,
    craft,
    available,
    nearestStation,

    fixedUpdate(dt) {
      for (const [key, q] of queues) {
        for (let i = q.length - 1; i >= 0; i--) {
          q[i].remaining -= dt;
          if (q[i].remaining <= 0) {
            const r = getRecipe(q[i].recipeId);
            if (r) completeRecipe(r);
            q.splice(i, 1);
          }
        }
        if (q.length === 0) queues.delete(key);
      }
    },

    serialize() {
      const out = [];
      for (const [station, q] of queues) out.push({ station, entries: q.map((e) => ({ ...e })) });
      return { queues: out };
    },

    hydrate(data) {
      queues.clear();
      for (const entry of data?.queues ?? []) {
        queues.set(entry.station, entry.entries.map((e) => ({ ...e })));
      }
    },
  };
}
