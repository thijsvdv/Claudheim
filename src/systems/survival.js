import { getItem } from '../data/items.js';

const MAX_FOOD_BUFFS = 3;
const REFUSE_DUPLICATE_ABOVE = 0.5; // fraction of duration remaining that blocks a re-eat
const RESTED_BASE_DURATION = 480;   // 8 minutes; doubled by the 'hearthfire' vow node
const RESTED_REGEN_BONUS = 2;       // extra hp/s and stam/s while Rested
const RESTED_XP_MULT = 1.25;        // exposed for other systems (progression) to read
const COLD_STAM_DRAIN = 6;          // per second
const COLD_HP_DRAIN = 4;            // per second, only once stamina is empty
const WET_DURATION = 180;           // 3 minutes
const WET_COLD_MULT = 1.5;

/**
 * Buffs raise maxHp/maxStam additively (VISION section 8). Hunger never
 * damages the player — there is deliberately no drain-to-zero path here.
 */
export function createSurvival(game) {
  const foodBuffs = []; // { itemId, name, icon, remaining, duration, hpBonus, stamBonus, regen }
  let rested = null;    // { remaining, duration } | null
  let wetRemaining = 0;
  let coldFor = 0;      // seconds continuously cold, for the HUD buff row
  let appliedMaxHp = 0;
  let appliedMaxStam = 0;

  function effects() { return game.progression?.effects ?? {}; }

  function totalFoodBonus() {
    let hp = 0, stam = 0, regen = 0;
    for (const b of foodBuffs) { hp += b.hpBonus; stam += b.stamBonus; regen += b.regen; }
    return { hp, stam, regen };
  }

  // Soft integration points: building.js (a peer system, owned separately)
  // may not exist yet, or may not implement these. Survival degrades to "no
  // Rested buff" rather than throwing if they're missing.
  function isSheltered(pos) {
    try { return !!game.get('building')?.isSheltered?.(pos); } catch { return false; }
  }
  function nearFire(pos) {
    try { return !!game.get('building')?.nearFire?.(pos, 6); } catch { return false; }
  }
  function wearingWarmGear() {
    const inv = game.inventory;
    if (!inv?.slots) return false;
    return inv.slots.some((s) => s && getItem(s.id)?.warmth);
  }

  function tickFood(dt) {
    for (let i = foodBuffs.length - 1; i >= 0; i--) {
      foodBuffs[i].remaining -= dt;
      if (foodBuffs[i].remaining <= 0) foodBuffs.splice(i, 1);
    }
  }

  function tickRested(dt) {
    const player = game.player;
    if (!player) return;
    const pos = player.position;
    const canRest = wetRemaining <= 0 && isSheltered(pos) && nearFire(pos);
    const maxDuration = RESTED_BASE_DURATION * (effects().restedMult ?? 1);
    if (canRest) {
      if (!rested) rested = { remaining: 0, duration: maxDuration };
      rested.duration = maxDuration;
      rested.remaining = Math.min(maxDuration, rested.remaining + dt * 3);
    } else if (rested) {
      rested.remaining -= dt;
      if (rested.remaining <= 0) rested = null;
    }
  }

  function tickTemperature(dt) {
    const player = game.player;
    if (!player) return;
    const pos = player.position;
    const world = game.world;

    const inWater = !!world?.isWater?.(pos.x, pos.z);
    wetRemaining = inWater ? WET_DURATION : Math.max(0, wetRemaining - dt);

    const biome = world?.biomeAt?.(pos.x, pos.z);
    const exposed = (biome === 'frostreach' && !!game.time?.isNight) || inWater;
    const immune = !!game.progression?.hasShard?.('rimehowl') || nearFire(pos) || wearingWarmGear();
    const cold = exposed && !immune;

    if (cold) {
      coldFor = Math.min(3600, coldFor + dt);
      const severity = wetRemaining > 0 ? WET_COLD_MULT : 1;
      const stats = player.stats;
      if (stats) {
        stats.stam = Math.max(0, stats.stam - COLD_STAM_DRAIN * severity * dt);
        if (stats.stam <= 0) player.damage?.({ amount: COLD_HP_DRAIN * severity * dt, type: 'frost', source: null });
      }
    } else {
      coldFor = Math.max(0, coldFor - dt * 2);
    }
  }

  function applyStatBonuses(dt) {
    const player = game.player;
    if (!player?.stats) return;

    const food = totalFoodBonus();
    const restFlat = rested ? 10 : 0;
    const newMaxHpBonus = food.hp + restFlat;
    const newMaxStamBonus = food.stam + restFlat;
    player.stats.maxHp += newMaxHpBonus - appliedMaxHp;
    player.stats.maxStam += newMaxStamBonus - appliedMaxStam;
    appliedMaxHp = newMaxHpBonus;
    appliedMaxStam = newMaxStamBonus;

    // Only the buff-derived bonus is applied here; baseline regen belongs to
    // player.js so the two systems don't fight over the same stat.
    const regenMult = effects().regenMult ?? 1;
    const hpRegenBonus = (food.regen + (rested ? RESTED_REGEN_BONUS : 0)) * regenMult;
    const stamRegenBonus = (rested ? RESTED_REGEN_BONUS : 0) * regenMult;
    if (hpRegenBonus > 0 && player.stats.hp < player.stats.maxHp) player.heal?.(hpRegenBonus * dt);
    if (stamRegenBonus > 0) player.stats.stam = Math.min(player.stats.maxStam, player.stats.stam + stamRegenBonus * dt);
  }

  const survival = {
    name: 'survival',

    init(g) { g.debug?.('survival: ready'); },

    fixedUpdate(dt) {
      tickFood(dt);
      tickRested(dt);
      tickTemperature(dt);
      applyStatBonuses(dt);
    },

    /** Timed food buff (VISION section 8): stacking, capped, no starvation damage. */
    eat(itemId) {
      const def = getItem(itemId);
      if (!def?.food) return false;
      const existingIdx = foodBuffs.findIndex((b) => b.itemId === itemId);
      if (existingIdx >= 0) {
        const b = foodBuffs[existingIdx];
        if (b.remaining / b.duration > REFUSE_DUPLICATE_ABOVE) return false;
        foodBuffs.splice(existingIdx, 1);
      }
      if (foodBuffs.length >= MAX_FOOD_BUFFS) return false;
      foodBuffs.push({
        itemId, name: def.name, icon: def.colour ?? 0xffffff,
        duration: def.food.duration, remaining: def.food.duration,
        hpBonus: def.food.hp ?? 0, stamBonus: def.food.stam ?? 0, regen: def.food.regen ?? 0,
      });
      return true;
    },

    get xpRateMult() { return rested ? RESTED_XP_MULT : 1; },
    get isRested() { return !!rested; },
    get isCold() { return coldFor > 0; },
    get isWet() { return wetRemaining > 0; },

    /** HUD-facing buff list. */
    get buffs() {
      const list = foodBuffs.map((b) => ({
        id: `food:${b.itemId}`, name: b.name, icon: b.icon, remaining: b.remaining, duration: b.duration,
      }));
      if (rested) list.push({ id: 'rested', name: 'Rested', icon: 0xffd24a, remaining: rested.remaining, duration: rested.duration });
      if (wetRemaining > 0) list.push({ id: 'wet', name: 'Wet', icon: 0x5b8fb8, remaining: wetRemaining, duration: WET_DURATION });
      if (coldFor > 0) list.push({ id: 'cold', name: 'Cold', icon: 0x8fd0e6, remaining: coldFor, duration: coldFor });
      return list;
    },

    serialize() {
      return { foodBuffs: foodBuffs.map((b) => ({ ...b })), rested, wetRemaining, coldFor };
    },
    hydrate(data) {
      if (!data) return;
      foodBuffs.length = 0;
      for (const b of data.foodBuffs || []) foodBuffs.push({ ...b });
      rested = data.rested ?? null;
      wetRemaining = data.wetRemaining ?? 0;
      coldFor = data.coldFor ?? 0;
    },
  };

  return survival;
}
