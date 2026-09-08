import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';
import { getBiome } from '../data/biomes.js';
import { getEnemy } from '../data/enemies.js';
import { getItem } from '../data/items.js';
import { clamp, damp, angleDelta } from '../core/math.js';
import { spawnEnemy } from './enemy.js';
import { createAIState, updateAI } from './ai.js';
import { initWardens, fixedUpdateWardens, renderWardens } from './wardens.js';
import { resolveBodyCollisions } from '../core/collision.js';

// Matches the chunk/load-radius convention in ARCHITECTURE.md; the world
// module doesn't expose "loaded area" directly, so this is our own estimate
// of how much ground is actually around the player to populate.
const CHUNK_SIZE = 32;
const LOAD_RADIUS_CHUNKS = 6;
const LOADED_RADIUS = CHUNK_SIZE * LOAD_RADIUS_CHUNKS;
const DENSITY_AREA_PER_ENEMY = 900; // m^2
const HARD_CAP = 40;
const MIN_PLAYER_DIST = 25;
const DESPAWN_DIST = 140;
const SPAWN_INTERVAL = 2.2;
const CORPSE_LINGER = 3;
const STAGGER_DRAIN = 14; // per second, meter recovers when not being hit
const PICKUP_LIFE = 60;
const PICKUP_RADIUS = 1.4;

let pickupGeo = null;
function pickupGeometry() {
  if (!pickupGeo) pickupGeo = new THREE.IcosahedronGeometry(0.14, 0);
  return pickupGeo;
}

function pickWeighted(rng, ids, game) {
  const weights = ids.map((id) => {
    const def = getEnemy(id);
    if (!def) return 0;
    if (def.night) return game.time.isNight ? 3 : 0.15;
    return 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < ids.length; i++) { r -= weights[i]; if (r <= 0) return ids[i]; }
  return ids[ids.length - 1];
}

export function createSpawner(game) {
  const rng = mulberry32((game.seed ^ 0x9e3779) >>> 0);
  const enemies = [];
  const pickups = [];
  let spawnTimer = 0;

  function difficultyMult() {
    const day = game.time?.day ?? 1;
    return {
      hpMult: 1 + clamp((day - 1) * 0.04, 0, 1.5),
      dmgMult: 1 + clamp((day - 1) * 0.03, 0, 1.2),
    };
  }

  function tryPopulate() {
    const player = game.player;
    if (!player) return;
    const area = Math.PI * LOADED_RADIUS * LOADED_RADIUS;
    const target = clamp(Math.round(area / DENSITY_AREA_PER_ENEMY), 0, HARD_CAP);
    if (enemies.length >= target) return;

    const a = rng() * Math.PI * 2;
    const r = MIN_PLAYER_DIST + Math.sqrt(rng()) * Math.max(1, LOADED_RADIUS - MIN_PLAYER_DIST);
    const x = player.position.x + Math.cos(a) * r;
    const z = player.position.z + Math.sin(a) * r;

    if (game.get?.('building')?.isBlocked?.(x, z)) return;

    const biomeId = game.world?.biomeAt?.(x, z) ?? 'fjaldmark';
    const spawns = getBiome(biomeId).spawns ?? [];
    if (!spawns.length) return;

    const enemyId = pickWeighted(rng, spawns, game);
    if (!enemyId) return;
    const def = getEnemy(enemyId);
    if (!def) return;

    const isWater = game.world?.isWater?.(x, z) ?? false;
    if (isWater && !def.water) return;

    const y = game.world?.heightAt?.(x, z) ?? 0;
    const entity = spawnEnemy(game, enemyId, new THREE.Vector3(x, y, z), difficultyMult());
    if (!entity) return;
    entity.aiState = createAIState(entity.def, rng);
    enemies.push(entity);
  }

  function tickEnemy(entity, dt) {
    entity.prevPosition.copy(entity.position);
    entity.prevFacing = entity.facing;

    if (entity.isDead) {
      entity.corpseTimer -= dt;
      return entity.corpseTimer <= 0;
    }

    updateAI(entity, game, dt, rng);
    entity.position.x += entity.velocity.x * dt;
    entity.position.z += entity.velocity.z * dt;
    const groundY = game.world?.heightAt?.(entity.position.x, entity.position.z) ?? entity.position.y;
    entity.position.y = groundY;

    // Same solid world the player walks in: a fence pens a boar, and a boulder
    // is something to path around rather than through.
    const bodyRadius = Math.max(0.35, (entity.radius ?? 0.5) * 0.7);
    const platform = resolveBodyCollisions(game, entity, {
      radius: bodyRadius, height: 1.6 * (entity.def?.scale ?? 1), step: 0.6,
    });
    if (platform > groundY) entity.position.y = platform;

    if (entity.staggered > 0) entity.staggered -= dt;
    else if (entity.stagger > 0) entity.stagger = Math.max(0, entity.stagger - STAGGER_DRAIN * dt);
    if (entity.flashTimer > 0) entity.flashTimer -= dt;

    const player = game.player;
    if (player && entity.position.distanceTo(player.position) > DESPAWN_DIST) return true;
    return false;
  }

  function spawnPickup(itemId, count, position, opts) {
    const item = getItem(itemId);
    const mat = new THREE.MeshStandardMaterial({
      color: item?.colour ?? 0xffffff, emissive: item?.colour ?? 0x222222, emissiveIntensity: 0.35,
    });
    const mesh = new THREE.Mesh(pickupGeometry(), mat);
    mesh.position.copy(position).add(new THREE.Vector3((rng() - 0.5) * 0.6, 0.3, (rng() - 0.5) * 0.6));
    mesh.userData.noCameraCollision = true;
    game.scene.add(mesh);
    pickups.push({
      mesh, itemId, count, base: mesh.position.clone(), life: PICKUP_LIFE,
      phase: rng() * Math.PI * 2,
      // Something you just dropped shouldn't leap back into your hands.
      armIn: opts?.delay ?? 0,
    });
  }

  function tickPickups(dt) {
    const player = game.player;
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      p.life -= dt;
      if (p.armIn > 0) p.armIn -= dt;
      let gone = p.life <= 0;
      if (!gone && p.armIn <= 0 && player && !player.isDead
          && p.mesh.position.distanceTo(player.position) < PICKUP_RADIUS) {
        // Overloaded: leave it lying there. inventory.add() already announces
        // what was picked up, so nothing to emit here.
        if (game.inventory?.canCarry?.() === false) {
          game.inventory.refuseCarry?.();
        } else {
          game.inventory?.add?.(p.itemId, p.count);
          gone = true;
        }
      }
      if (gone) { game.scene.remove(p.mesh); pickups.splice(i, 1); }
    }
  }

  const spawner = {
    name: 'spawner',
    spawnPickup,

    init() {
      initWardens(game);
    },

    fixedUpdate(dt) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnTimer = SPAWN_INTERVAL; tryPopulate(); }

      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        const remove = tickEnemy(e, dt);
        if (remove) {
          game.scene.remove(e.mesh);
          game.entities.remove(e);
          enemies.splice(i, 1);
        }
      }

      tickPickups(dt);
      fixedUpdateWardens(game, dt);
    },

    update(dt, _game, alpha) {
      const a = clamp(alpha ?? 1, 0, 1);
      for (const e of enemies) {
        e.mesh.position.lerpVectors(e.prevPosition, e.position, a);
        e.mesh.rotation.y = e.prevFacing + angleDelta(e.prevFacing, e.facing) * a;

        if (e.isDead) {
          const t = 1 - clamp(e.corpseTimer / CORPSE_LINGER, 0, 1);
          e.mesh.rotation.z = damp(e.mesh.rotation.z, Math.PI / 2, 6, dt) * Math.min(1, t * 3);
          e.mesh.scale.y = 1 - 0.3 * t;
          continue;
        }

        for (const mat of e.mesh.userData.materials ?? []) {
          const flash = e.flashTimer > 0 ? 1 : 0;
          const tele = e.telegraph ? 1 : 0;
          mat.emissive.setRGB(Math.max(flash, tele * 0.9), flash + tele * 0.3, flash);
          mat.emissiveIntensity = flash > 0 || tele > 0 ? 1 : 0;
        }

        const speed = Math.hypot(e.velocity.x, e.velocity.z);
        if (speed > 0.05 && e.mesh.userData.legs) {
          const phase = game.time.elapsed * speed * 1.6;
          e.mesh.userData.legs.forEach((leg, i) => {
            leg.rotation.x = Math.sin(phase + i * Math.PI) * 0.5;
          });
        } else if (e.mesh.userData.arms) {
          e.mesh.userData.arms.forEach((arm) => { arm.rotation.x = 0; });
        }
      }

      for (const p of pickups) {
        p.mesh.position.y = p.base.y + 0.35 + Math.sin(game.time.elapsed * 2.4 + p.phase) * 0.1;
        p.mesh.rotation.y += dt * 1.4;
      }

      renderWardens(game, dt, a);
    },

    dispose() {
      for (const e of enemies) { game.scene.remove(e.mesh); game.entities.remove(e); }
      enemies.length = 0;
      for (const p of pickups) game.scene.remove(p.mesh);
      pickups.length = 0;
    },
  };

  return spawner;
}
