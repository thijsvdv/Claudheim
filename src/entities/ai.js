import { angleDelta, inArc, randRange } from '../core/math.js';
import { attackHit } from './enemy.js';

/**
 * Shared behaviour state machine for every non-warden enemy. Wardens
 * (`def.ai === 'warden'`) are driven entirely by wardens.js instead, since
 * their move sets don't fit this generic mould.
 *
 * Modes: idle -> alert -> chase -> attack (windup/active/recover sub-phases)
 * -> recover -> chase | flee. `skittish` starts by fleeing on sight and only
 * enters the normal chase/attack loop once it has actually been hit.
 */

const T = {
  wanderRadius: 6,
  wanderPauseMin: 1.5, wanderPauseMax: 4,
  alertTime: 0.5,
  windup: 0.7, active: 0.25, recoverTime: 0.6,
  fleeSpeedMult: 1.15,
  faceLambda: 10,
  circleArc: 2.3, // ~132 degrees either side counts as "facing this enemy"
};

export function createAIState(def, rng) {
  return {
    mode: 'idle',
    timer: randRange(rng, T.wanderPauseMin, T.wanderPauseMax),
    wanderTarget: null,
    damagedEver: false,
    circleDir: rng() < 0.5 ? 1 : -1,
    phase: 'windup', phaseT: 0, hitApplied: false,
    cooldown: 0,
    fleeFrom: null,
  };
}

/** Applies a hit the same way regardless of who ends up resolving it, so
 * block/parry (owned by systems/combat.js) still mitigates monster attacks
 * when that system exists — falling back to a direct `damage()` call so
 * enemies still hurt the player if combat.js hasn't booted. */
export function resolveHit(game, target, hit) {
  if (game.combat?.applyHit) game.combat.applyHit(target, hit);
  else target.damage ? target.damage(hit) : target.takeHit?.(hit);
}

function findNearestFire(game, pos, radius) {
  // Fires are placed pieces, so the building system owns them.
  const fire = game.get?.('building')?.fireNear?.(pos, radius);
  return fire?.position ?? null;
}

/** Pack members within range join the chase when one of them spots the player. */
function alertPack(entity, game) {
  const allies = game.entities.near(entity.position, 25, (e) => e !== entity && e.def?.ai === 'pack' && e.faction === entity.faction && e.aiState?.mode === 'idle');
  for (const ally of allies) { ally.aiState.mode = 'alert'; ally.aiState.timer = T.alertTime; }
}

function pickWanderTarget(entity, rng) {
  const a = rng() * Math.PI * 2;
  const r = rng() * T.wanderRadius;
  return { x: entity.spawnPos.x + Math.cos(a) * r, z: entity.spawnPos.z + Math.sin(a) * r };
}

/** Steers away from deep water the enemy can't enter; a cheap tangent turn
 * rather than real pathfinding, which is plenty for skirting a pond. */
function avoidWater(entity, game, vx, vz) {
  if (entity.def.water) return [vx, vz];
  const nx = entity.position.x + vx * 0.6, nz = entity.position.z + vz * 0.6;
  if (!game.world?.isWater?.(nx, nz)) return [vx, vz];
  const depth = -(game.world?.heightAt?.(nx, nz) ?? 0);
  if (depth <= 0.3) return [vx, vz];
  return [-vz, vx];
}

function faceToward(entity, dt, dirX, dirZ, lambda = T.faceLambda) {
  if (Math.hypot(dirX, dirZ) < 1e-4) return;
  const targetYaw = Math.atan2(dirX, dirZ);
  entity.facing += angleDelta(entity.facing, targetYaw) * (1 - Math.exp(-lambda * dt));
}

function setVelocity(entity, game, dirX, dirZ, speed) {
  const len = Math.hypot(dirX, dirZ) || 1;
  const [vx, vz] = avoidWater(entity, game, (dirX / len) * speed, (dirZ / len) * speed);
  entity.velocity.x = vx;
  entity.velocity.z = vz;
}

export function updateAI(entity, game, dt, rng) {
  const def = entity.def;
  if (!def || def.ai === 'warden') return;
  const st = entity.aiState;
  const player = game.player;

  if (st.cooldown > 0) st.cooldown -= dt;

  if (def.fearsFire) {
    const fire = findNearestFire(game, entity.position, 8);
    if (fire && st.mode !== 'attack') {
      st.mode = 'flee';
      st.fleeFrom = fire;
    }
  }

  if (!player || player.isDead) {
    entity.velocity.set(0, 0, 0);
    return;
  }

  const dx = player.position.x - entity.position.x;
  const dz = player.position.z - entity.position.z;
  const dist = Math.hypot(dx, dz);

  switch (st.mode) {
    case 'idle': {
      st.timer -= dt;
      if (!st.wanderTarget || st.timer <= 0) {
        st.wanderTarget = pickWanderTarget(entity, rng);
        st.timer = randRange(rng, T.wanderPauseMin, T.wanderPauseMax);
      }
      const wx = st.wanderTarget.x - entity.position.x;
      const wz = st.wanderTarget.z - entity.position.z;
      if (Math.hypot(wx, wz) > 0.5) { setVelocity(entity, game, wx, wz, def.speed * 0.35); faceToward(entity, dt, wx, wz); }
      else entity.velocity.set(0, 0, 0);

      const aggro = def.ai === 'ambush' ? def.aggroRange * 0.35 : def.aggroRange;
      if (dist < aggro) {
        if (def.ai === 'skittish' && !st.damagedEver) { st.mode = 'flee'; st.fleeFrom = player; }
        else { st.mode = 'alert'; st.timer = T.alertTime; if (def.ai === 'pack') alertPack(entity, game); }
      }
      break;
    }

    case 'alert': {
      entity.velocity.set(0, 0, 0);
      faceToward(entity, dt, dx, dz);
      st.timer -= dt;
      if (dist > def.aggroRange * 1.6) { st.mode = 'idle'; }
      else if (st.timer <= 0) st.mode = 'chase';
      break;
    }

    case 'chase': {
      if (dist > def.aggroRange * 2.2) { st.mode = 'idle'; st.wanderTarget = null; break; }

      const wantsCircle = def.ai === 'pack' && dist <= def.attackRange * 1.6
        && inArc(entity.position.x, entity.position.z, Math.sin(player.facing), Math.cos(player.facing), player.position.x, player.position.z, T.circleArc);

      if (wantsCircle && st.cooldown > 0) {
        // Strafe tangentially around the player instead of walking into a facing target.
        const tx = -dz * st.circleDir, tz = dx * st.circleDir;
        setVelocity(entity, game, tx, tz, def.speed);
        faceToward(entity, dt, dx, dz);
        if (rng() < dt * 0.2) st.circleDir *= -1;
      } else if (def.ai === 'ranged' && dist < def.attackRange * 0.5) {
        setVelocity(entity, game, -dx, -dz, def.chaseSpeed); // kite away
        faceToward(entity, dt, dx, dz);
      } else if (dist <= def.attackRange) {
        entity.velocity.set(0, 0, 0);
        faceToward(entity, dt, dx, dz);
        if (st.cooldown <= 0) { st.mode = 'attack'; st.phase = 'windup'; st.phaseT = 0; st.hitApplied = false; }
      } else {
        setVelocity(entity, game, dx, dz, def.chaseSpeed);
        faceToward(entity, dt, dx, dz);
      }
      break;
    }

    case 'attack': {
      entity.velocity.set(0, 0, 0);
      entity.telegraph = st.phase === 'windup';
      faceToward(entity, dt, dx, dz, T.faceLambda * 1.6);
      st.phaseT += dt;

      if (st.phase === 'windup' && st.phaseT >= T.windup) { st.phase = 'active'; st.phaseT = 0; }
      else if (st.phase === 'active') {
        const canReach = dist <= def.attackRange + 0.4 &&
          inArc(entity.position.x, entity.position.z, Math.sin(entity.facing), Math.cos(entity.facing), player.position.x, player.position.z, 1.4);
        if (!st.hitApplied && canReach) {
          resolveHit(game, player, attackHit(def, entity, entity.def.dmgMult ?? 1));
          st.hitApplied = true;
        }
        if (st.phaseT >= T.active) { st.phase = 'recover'; st.phaseT = 0; st.mode = 'recover'; st.timer = T.recoverTime; }
      }
      break;
    }

    case 'recover': {
      entity.velocity.set(0, 0, 0);
      st.timer -= dt;
      if (st.timer <= 0) {
        st.cooldown = def.attackCd;
        const hurt = entity.hp / entity.maxHp < 0.25;
        st.mode = hurt && def.ai !== 'aggressive' && def.ai !== 'pack' ? 'flee' : 'chase';
        if (st.mode === 'flee') st.fleeFrom = player;
      }
      break;
    }

    case 'flee': {
      if (def.ai === 'skittish' && st.damagedEver) { st.mode = 'chase'; break; }
      const from = st.fleeFrom ?? player;
      const fx = entity.position.x - from.position.x;
      const fz = entity.position.z - from.position.z;
      setVelocity(entity, game, fx, fz, def.chaseSpeed * T.fleeSpeedMult);
      faceToward(entity, dt, fx, fz);
      if (Math.hypot(fx, fz) > def.aggroRange * 1.8) { st.mode = 'idle'; st.wanderTarget = null; st.fleeFrom = null; }
      break;
    }

    default:
      st.mode = 'idle';
  }
}
