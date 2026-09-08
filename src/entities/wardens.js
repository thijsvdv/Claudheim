import * as THREE from 'three';
import { makeDamageable } from '../core/entities.js';
import { WARDENS } from '../data/enemies.js';
import { createEnemyMesh, dropLoot } from './enemy.js';
import { resolveHit } from './ai.js';
import { clamp, angleDelta, inArc, pick } from '../core/math.js';
import { mulberry32 } from '../world/noise.js';

// The Hollow Stag altar sits at a fixed spot within Fjaldmark's ring so every
// run of a given seed finds it in the same clearing.
const ALTAR_SPOT = { x: 52, z: -18 };
const ENGAGE_RANGE = 24;
const LEASH_RANGE = 40;

const MOVE_TIMING = {
  charge: { windup: 0.9, active: 0.55, recover: 0.9, hitRange: 2.6, damage: 45, knockback: 11, speedMult: 2.6 },
  gore: { windup: 0.6, active: 0.3, recover: 0.7, hitRange: 3.4, arc: 1.6, damage: 30, knockback: 5 },
  lightning: { windup: 0.35, delay: 1.15, radius: 3.5, damage: 40, knockback: 2 },
};

let enc = null; // one Hollow Stag encounter at a time is enough for the slice

function buildAltarMesh() {
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6b6a63, roughness: 1 });
  const runeMat = new THREE.MeshStandardMaterial({ color: 0xff8c42, emissive: 0x7a3c14, emissiveIntensity: 0.7 });
  const group = new THREE.Group();

  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.7, 0.5, 8), stoneMat);
  base.position.y = 0.25;
  group.add(base);

  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.9), stoneMat);
  slab.position.y = 0.65;
  group.add(slab);

  for (let i = 0; i < 4; i++) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.3, 6), stoneMat);
    const a = (i / 4) * Math.PI * 2;
    pillar.position.set(Math.cos(a) * 1.15, 0.9, Math.sin(a) * 1.15);
    group.add(pillar);
  }

  const rune = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.05, 6, 12), runeMat);
  rune.rotation.x = Math.PI / 2;
  rune.position.y = 0.85;
  group.add(rune);

  group.userData.rune = rune;
  group.userData.noCameraCollision = true;
  return group;
}

function buildTelegraphMeshes() {
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xff3c1e, transparent: true, opacity: 0.5, depthWrite: false });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });

  const line = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lineMat);
  line.rotation.x = -Math.PI / 2;
  line.visible = false;
  line.userData.noCameraCollision = true;

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 28), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  ring.userData.noCameraCollision = true;

  return { line, ring };
}

/** The warden currently on the field, or null. Read by the HUD boss bar. */
export function activeWarden() {
  return enc?.active && enc.boss && !enc.boss.isDead ? enc.boss : null;
}

export function initWardens(game) {
  const def = WARDENS.hollow_stag;
  const groundY = game.world?.heightAt?.(ALTAR_SPOT.x, ALTAR_SPOT.z) ?? 0;
  const altarMesh = buildAltarMesh();
  altarMesh.position.set(ALTAR_SPOT.x, groundY, ALTAR_SPOT.z);
  game.scene.add(altarMesh);

  const telegraphs = buildTelegraphMeshes();
  game.scene.add(telegraphs.line, telegraphs.ring);

  enc = {
    def,
    altarPos: altarMesh.position.clone(),
    altarMesh,
    telegraphs,
    boss: null,
    active: false,
    rng: mulberry32((game.seed ^ 0x5747a1) >>> 0),
  };
}

function faceBoss(boss, dt, dx, dz, lambda = 8) {
  if (Math.hypot(dx, dz) < 1e-4) return;
  const targetYaw = Math.atan2(dx, dz);
  boss.facing += angleDelta(boss.facing, targetYaw) * (1 - Math.exp(-lambda * dt));
}

function setBossVelocity(boss, dx, dz, speed) {
  const len = Math.hypot(dx, dz) || 1;
  boss.velocity.x = (dx / len) * speed;
  boss.velocity.z = (dz / len) * speed;
}

function applyBossHit(game, boss, timing, enrage) {
  resolveHit(game, game.player, {
    amount: timing.damage * enrage, type: 'blunt', stagger: 40,
    knockback: timing.knockback, source: boss, crit: false,
  });
}

function summonBoss(game) {
  const def = enc.def;
  const pos = enc.altarPos.clone();
  pos.x += 5; pos.z += 5;
  pos.y = game.world?.heightAt?.(pos.x, pos.z) ?? enc.altarPos.y;

  const mesh = createEnemyMesh(def.build, def.scale ?? 1);
  mesh.position.copy(pos);
  game.scene.add(mesh);

  const boss = {
    mesh, def, position: pos.clone(), prevPosition: pos.clone(), velocity: new THREE.Vector3(),
    facing: Math.PI, prevFacing: Math.PI, flashTimer: 0, telegraph: false, corpseTimer: 0,
    phaseIndex: 0, moveState: 'seek', moveName: null, moveT: 0, hitApplied: false, cooldown: 1.5,
    moveTarget: new THREE.Vector3(), chargeDir: { x: 0, z: 1 },
  };
  makeDamageable(boss, { hp: def.hp, faction: 'warden', radius: 1.6 * (def.scale ?? 1), maxStagger: def.stagger });

  boss.takeHit = function takeHit(hit) {
    if (boss.isDead) return { amount: 0, killed: false, staggered: false, crit: false };
    const amount = Math.max(1, (hit.amount || 0) - (def.armour || 0));
    boss.hp = clamp(boss.hp - amount, 0, boss.maxHp);
    boss.flashTimer = 0.14;
    let staggered = false;
    if (boss.staggered <= 0) {
      boss.stagger = clamp(boss.stagger + (hit.stagger || 0), 0, boss.maxStagger);
      if (boss.stagger >= boss.maxStagger) { boss.staggered = 2; boss.stagger = 0; staggered = true; }
    }
    if (boss.hp <= 0 && !boss.isDead) killBoss(game, boss);
    return { amount, killed: boss.isDead, staggered, crit: hit.crit ?? false };
  };

  game.entities.add(boss);
  enc.boss = boss;
  enc.active = true;
}

function killBoss(game, boss) {
  boss.isDead = true;
  boss.corpseTimer = 4;
  game.bus.emit('entity:killed', { entity: boss, source: null, position: boss.position.clone() });
  const def = boss.def;
  game.progression?.gainXp?.('combat', def.xp);
  if (game.progression) game.progression.oathmarks = (game.progression.oathmarks ?? 0) + def.marks;
  dropLoot(game, boss.position, def.drops, enc.rng);
  game.bus.emit('warden:defeated', { id: def.id, shard: def.shard, marks: def.marks, xp: def.xp, position: boss.position.clone() });
  hideTelegraphs();
}

function hideTelegraphs() {
  enc.telegraphs.line.visible = false;
  enc.telegraphs.ring.visible = false;
}

function beginMove(boss, name, player) {
  boss.moveName = name;
  boss.moveState = 'windup';
  boss.moveT = 0;
  boss.hitApplied = false;
  boss.moveTarget.copy(player.position);
  if (name === 'charge') {
    const dx = boss.moveTarget.x - boss.position.x, dz = boss.moveTarget.z - boss.position.z;
    const len = Math.hypot(dx, dz) || 1;
    boss.chargeDir = { x: dx / len, z: dz / len };
  }
}

function tickMoveTelegraph(boss, game) {
  const t = enc.telegraphs;
  if (boss.moveName === 'charge' && boss.moveState === 'windup') {
    const len = 20;
    t.line.visible = true;
    t.line.scale.set(1.4, len, 1);
    t.line.position.set(
      boss.position.x + boss.chargeDir.x * len / 2,
      (game.world?.heightAt?.(boss.position.x, boss.position.z) ?? boss.position.y) + 0.05,
      boss.position.z + boss.chargeDir.z * len / 2,
    );
    t.line.rotation.z = -Math.atan2(boss.chargeDir.x, boss.chargeDir.z);
  } else if (boss.moveName !== 'charge' || boss.moveState !== 'windup') {
    t.line.visible = false;
  }
}

function updateLightningRing(boss, game, t01) {
  const t = enc.telegraphs;
  const timing = MOVE_TIMING.lightning;
  t.ring.visible = true;
  t.ring.position.set(boss.moveTarget.x, (game.world?.heightAt?.(boss.moveTarget.x, boss.moveTarget.z) ?? boss.moveTarget.y) + 0.05, boss.moveTarget.z);
  const scale = timing.radius;
  t.ring.scale.set(scale, scale, scale);
  t.ring.material.opacity = 0.25 + 0.5 * t01;
}

function resolveLightning(boss, game, enrage) {
  const timing = MOVE_TIMING.lightning;
  const player = game.player;
  if (player) {
    const d = Math.hypot(player.position.x - boss.moveTarget.x, player.position.z - boss.moveTarget.z);
    if (d <= timing.radius) applyBossHit(game, boss, timing, enrage);
  }
  enc.telegraphs.ring.visible = false;
}

function tickBoss(boss, game, dt) {
  if (boss.staggered > 0) { boss.staggered -= dt; boss.velocity.set(0, 0, 0); return; }
  const def = boss.def;
  const fraction = boss.maxHp > 0 ? boss.hp / boss.maxHp : 0;
  boss.phaseIndex = fraction <= def.phases[1].at ? 1 : 0;
  const phase = def.phases[boss.phaseIndex];
  const enrage = phase.enrage ?? 1;
  const player = game.player;
  if (!player || player.isDead) { boss.velocity.set(0, 0, 0); return; }

  const dx = player.position.x - boss.position.x, dz = player.position.z - boss.position.z;
  const dist = Math.hypot(dx, dz);
  if (boss.cooldown > 0) boss.cooldown -= dt;

  switch (boss.moveState) {
    case 'seek': {
      boss.telegraph = false;
      if (dist > 3.2) { setBossVelocity(boss, dx, dz, phase.speed); faceBoss(boss, dt, dx, dz); }
      else boss.velocity.set(0, 0, 0);
      if (boss.cooldown <= 0 && dist < ENGAGE_RANGE) beginMove(boss, pick(enc.rng, phase.moves), player);
      break;
    }
    case 'windup': {
      boss.velocity.set(0, 0, 0);
      boss.telegraph = true;
      faceBoss(boss, dt, boss.moveTarget.x - boss.position.x, boss.moveTarget.z - boss.position.z, 14);
      boss.moveT += dt;
      tickMoveTelegraph(boss, game);
      const timing = MOVE_TIMING[boss.moveName];
      if (boss.moveT >= timing.windup) {
        boss.telegraph = false;
        boss.moveT = 0;
        boss.moveState = boss.moveName === 'lightning' ? 'delay' : 'active';
      }
      break;
    }
    case 'delay': {
      boss.velocity.set(0, 0, 0);
      boss.moveT += dt;
      updateLightningRing(boss, game, boss.moveT / MOVE_TIMING.lightning.delay);
      if (boss.moveT >= MOVE_TIMING.lightning.delay) {
        resolveLightning(boss, game, enrage);
        boss.moveState = 'recover'; boss.moveT = 0;
      }
      break;
    }
    case 'active': {
      const timing = MOVE_TIMING[boss.moveName];
      boss.moveT += dt;
      if (boss.moveName === 'charge') {
        setBossVelocity(boss, boss.chargeDir.x, boss.chargeDir.z, phase.speed * timing.speedMult);
        if (!boss.hitApplied && dist < timing.hitRange) { applyBossHit(game, boss, timing, enrage); boss.hitApplied = true; }
      } else if (boss.moveName === 'gore') {
        boss.velocity.set(0, 0, 0);
        const facing = inArc(boss.position.x, boss.position.z, Math.sin(boss.facing), Math.cos(boss.facing), player.position.x, player.position.z, timing.arc);
        if (!boss.hitApplied && dist <= timing.hitRange && facing) { applyBossHit(game, boss, timing, enrage); boss.hitApplied = true; }
      }
      if (boss.moveT >= timing.active) { boss.moveState = 'recover'; boss.moveT = 0; }
      break;
    }
    case 'recover': {
      boss.velocity.set(0, 0, 0);
      boss.moveT += dt;
      const timing = MOVE_TIMING[boss.moveName] ?? { recover: 0.6 };
      if (boss.moveT >= timing.recover) { boss.moveState = 'seek'; boss.cooldown = 1.1; boss.moveName = null; }
      break;
    }
  }

  // Leash: an over-eager player kiting the stag off its clearing snaps it back.
  const homeDist = Math.hypot(boss.position.x - enc.altarPos.x, boss.position.z - enc.altarPos.z);
  if (homeDist > LEASH_RANGE) {
    const hx = enc.altarPos.x - boss.position.x, hz = enc.altarPos.z - boss.position.z;
    setBossVelocity(boss, hx, hz, phase.speed * 1.5);
  }
}

function groundSnap(game, boss, dt) {
  boss.position.x += boss.velocity.x * dt;
  boss.position.z += boss.velocity.z * dt;
  boss.position.y = game.world?.heightAt?.(boss.position.x, boss.position.z) ?? boss.position.y;
}

/** Called once per fixed step (60 Hz) from the spawner system. */
export function fixedUpdateWardens(game, dt) {
  if (!enc) return;

  if (!enc.active) {
    const player = game.player;
    if (player && !player.isDead) {
      const d = player.position.distanceTo(enc.altarPos);
      if (d < 3.5 && game.input.wasPressed('interact')) {
        const need = enc.def.altarCount ?? 1;
        if (game.inventory?.count?.(enc.def.altarItem) >= need) {
          game.inventory.remove(enc.def.altarItem, need);
          summonBoss(game);
        } else {
          game.bus.emit('notice', { text: `The altar wants an offering: ${need} x ${enc.def.altarItem.replace('_', ' ')}.` });
        }
      }
    }
    return;
  }

  const boss = enc.boss;
  if (!boss) return;
  boss.prevPosition.copy(boss.position);
  boss.prevFacing = boss.facing;

  if (boss.isDead) {
    boss.corpseTimer -= dt;
    if (boss.corpseTimer <= 0) {
      game.scene.remove(boss.mesh);
      game.entities.remove(boss);
      enc.boss = null;
      enc.active = false;
    }
    return;
  }

  tickBoss(boss, game, dt);
  groundSnap(game, boss, dt);
  if (boss.flashTimer > 0) boss.flashTimer -= dt;
}

/** Called once per render frame from the spawner system. */
export function renderWardens(game, dt, alpha) {
  if (!enc) return;
  if (enc.altarMesh.userData.rune) enc.altarMesh.userData.rune.rotation.z += dt * 0.6;

  const boss = enc.boss;
  if (!boss) return;
  const a = clamp(alpha ?? 1, 0, 1);
  boss.mesh.position.lerpVectors(boss.prevPosition, boss.position, a);
  boss.mesh.rotation.y = boss.prevFacing + angleDelta(boss.prevFacing, boss.facing) * a;

  for (const mat of boss.mesh.userData.materials ?? []) {
    const target = boss.flashTimer > 0 ? 1 : boss.telegraph ? 0.6 : 0;
    mat.emissive?.setRGB(target, target * (boss.telegraph ? 0.5 : 1), 0);
    mat.emissiveIntensity = target > 0 ? 1 : 0;
  }
}
