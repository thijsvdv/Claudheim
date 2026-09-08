import * as THREE from 'three';
import { makeDamageable } from '../core/entities.js';
import { getEnemy } from '../data/enemies.js';
import { clamp } from '../core/math.js';

const FLASH_TIME = 0.14;
const TELEGRAPH_COLOR = new THREE.Color(0xff9a3c);
const HIT_COLOR = new THREE.Color(0xffffff);

// Geometries are pure shape and never mutated, so every enemy of a given
// build shares one set — only materials are cloned per-instance (needed for
// independent hit-flash/telegraph tinting).
const geoCache = new Map();
function sharedGeo(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = build(); geoCache.set(key, g); }
  return g;
}

function cloneMat(color, extra) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
}

/** A quadruped torso + 4 legs + head, parameterised for boar/neck/wolf. */
function buildQuadruped({ bodyLen, bodyRad, legLen, legRad, headRad, snoutLen, bodyColor, accentColor, earStyle }) {
  const g = sharedGeo(`quad:${bodyLen}:${bodyRad}:${legLen}:${legRad}:${headRad}:${snoutLen}`, () => ({
    body: new THREE.CapsuleGeometry(bodyRad, bodyLen, 3, 8),
    leg: new THREE.CylinderGeometry(legRad * 0.8, legRad, legLen, 5),
    head: new THREE.SphereGeometry(headRad, 10, 8),
    snout: new THREE.ConeGeometry(headRad * 0.55, snoutLen, 8),
    ear: new THREE.ConeGeometry(headRad * 0.35, headRad * 0.6, 6),
    tail: new THREE.ConeGeometry(bodyRad * 0.3, bodyRad * 1.4, 6),
  }));

  const group = new THREE.Group();
  const bodyMat = cloneMat(bodyColor);
  const accentMat = cloneMat(accentColor);
  const materials = [bodyMat, accentMat];

  const body = new THREE.Mesh(g.body, bodyMat);
  body.rotation.z = Math.PI / 2;
  body.position.y = legLen + bodyRad;
  body.castShadow = true;
  group.add(body);

  const headY = body.position.y + bodyRad * 0.3;
  const headZ = bodyLen / 2 + bodyRad * 0.6;
  const head = new THREE.Mesh(g.head, bodyMat);
  head.position.set(0, headY, headZ);
  head.castShadow = true;
  group.add(head);

  const snout = new THREE.Mesh(g.snout, accentMat);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, headY - headRad * 0.15, headZ + headRad * 0.6 + snoutLen / 2);
  group.add(snout);

  if (earStyle) {
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(g.ear, accentMat);
      ear.position.set(s * headRad * 0.5, headY + headRad * 0.7, headZ - headRad * 0.2);
      ear.rotation.z = s * 0.3;
      group.add(ear);
    }
  }

  const tail = new THREE.Mesh(g.tail, accentMat);
  tail.rotation.x = -Math.PI / 2.4;
  tail.position.set(0, body.position.y + bodyRad * 0.2, -bodyLen / 2 - bodyRad * 0.4);
  group.add(tail);

  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(g.leg, bodyMat);
    leg.position.set(sx * bodyRad * 0.6, legLen / 2, sz * (bodyLen / 2 - bodyRad * 0.3));
    leg.castShadow = true;
    group.add(leg);
    legs.push(leg);
  }

  group.userData.materials = materials;
  group.userData.legs = legs;
  return group;
}

function buildHumanoid({ height, radius, headRad, bodyColor, headColor, hunched, angularHead }) {
  const g = sharedGeo(`humanoid:${height}:${radius}:${headRad}:${hunched}:${angularHead}`, () => ({
    torso: new THREE.CapsuleGeometry(radius, height * 0.55, 3, 8),
    head: angularHead ? new THREE.BoxGeometry(headRad * 1.5, headRad * 1.6, headRad * 1.3)
                       : new THREE.SphereGeometry(headRad, 10, 8),
    limb: new THREE.CapsuleGeometry(radius * 0.35, height * 0.4, 3, 6),
  }));

  const group = new THREE.Group();
  const bodyMat = cloneMat(bodyColor);
  const headMat = cloneMat(headColor);
  const materials = [bodyMat, headMat];

  const legLen = height * 0.42;
  const torso = new THREE.Mesh(g.torso, bodyMat);
  torso.position.y = legLen + height * 0.28;
  torso.castShadow = true;
  if (hunched) torso.rotation.x = 0.25;
  group.add(torso);

  const head = new THREE.Mesh(g.head, headMat);
  head.position.set(0, torso.position.y + height * 0.35, hunched ? height * 0.12 : 0);
  head.castShadow = true;
  group.add(head);

  const armPivots = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * radius * 1.3, torso.position.y + height * 0.18, 0);
    const arm = new THREE.Mesh(g.limb, bodyMat);
    arm.position.y = -height * 0.2;
    arm.castShadow = true;
    pivot.add(arm);
    group.add(pivot);
    armPivots.push(pivot);
  }

  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(g.limb, bodyMat);
    leg.position.set(s * radius * 0.5, legLen * 0.5, 0);
    leg.castShadow = true;
    group.add(leg);
  }

  group.userData.materials = materials;
  group.userData.arms = armPivots;
  return group;
}

function buildStag(scale) {
  const g = sharedGeo('stag', () => ({
    ribs: new THREE.BoxGeometry(0.5, 1.0, 2.2),
    neck: new THREE.CylinderGeometry(0.22, 0.3, 1.1, 6),
    skull: new THREE.BoxGeometry(0.4, 0.45, 0.75),
    leg: new THREE.CylinderGeometry(0.1, 0.14, 1.5, 6),
    antler: new THREE.CylinderGeometry(0.04, 0.07, 0.9, 5),
  }));

  const group = new THREE.Group();
  const boneMat = cloneMat(0xcfc7b8, { roughness: 0.95 });
  const darkMat = cloneMat(0x2c2622, { roughness: 1 });
  const materials = [boneMat, darkMat];

  const legLen = 1.5;
  const body = new THREE.Mesh(g.ribs, boneMat);
  body.position.y = legLen + 0.5;
  body.castShadow = true;
  group.add(body);

  const neck = new THREE.Mesh(g.neck, boneMat);
  neck.position.set(0, body.position.y + 0.75, 1.15);
  neck.rotation.x = -0.55;
  neck.castShadow = true;
  group.add(neck);

  const skull = new THREE.Mesh(g.skull, darkMat);
  skull.position.set(0, neck.position.y + 0.55, 1.55);
  skull.castShadow = true;
  group.add(skull);

  for (const s of [-1, 1]) {
    const base = new THREE.Vector3(s * 0.14, skull.position.y + 0.25, skull.position.z - 0.1);
    for (let branch = 0; branch < 3; branch++) {
      const antler = new THREE.Mesh(g.antler, darkMat);
      antler.position.copy(base).add(new THREE.Vector3(s * branch * 0.12, branch * 0.32, -branch * 0.1));
      antler.rotation.z = s * (0.3 + branch * 0.35);
      antler.rotation.x = -0.2 - branch * 0.15;
      antler.scale.setScalar(1 - branch * 0.22);
      group.add(antler);
    }
  }

  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(g.leg, darkMat);
    leg.position.set(sx * 0.22, legLen / 2, sz * 0.9);
    leg.castShadow = true;
    group.add(leg);
    legs.push(leg);
  }

  group.userData.materials = materials;
  group.userData.legs = legs;
  group.scale.setScalar(scale);
  return group;
}

const BUILDERS = {
  boar: () => buildQuadruped({
    bodyLen: 0.9, bodyRad: 0.32, legLen: 0.42, legRad: 0.12, headRad: 0.22,
    snoutLen: 0.28, bodyColor: 0x6b4a3a, accentColor: 0x3a2620, earStyle: true,
  }),
  neck: () => buildQuadruped({
    bodyLen: 1.1, bodyRad: 0.16, legLen: 0.14, legRad: 0.06, headRad: 0.13,
    snoutLen: 0.22, bodyColor: 0x4a6b4a, accentColor: 0x2e4530, earStyle: false,
  }),
  wolf: () => buildQuadruped({
    bodyLen: 1.0, bodyRad: 0.26, legLen: 0.55, legRad: 0.09, headRad: 0.2,
    snoutLen: 0.3, bodyColor: 0xd8dee2, accentColor: 0x9aa4ab, earStyle: true,
  }),
  greyfolk: () => buildHumanoid({
    height: 1.5, radius: 0.24, headRad: 0.18, bodyColor: 0x5c6b4a, headColor: 0x6b7a56, hunched: true,
  }),
  draugr: () => buildHumanoid({
    height: 1.9, radius: 0.26, headRad: 0.2, bodyColor: 0x4a5258, headColor: 0x3a4046,
    hunched: false, angularHead: true,
  }),
  stag: (scale = 1) => buildStag(scale),
};

/** Procedural low-poly mesh for a `build` id from data/enemies.js. */
export function createEnemyMesh(buildId, scale = 1) {
  const build = BUILDERS[buildId] || BUILDERS.greyfolk;
  const mesh = buildId === 'stag' ? build(scale) : build();
  if (buildId !== 'stag') mesh.scale.setScalar(scale);
  mesh.traverse((o) => { o.userData.enemyBody = true; });
  return mesh;
}

function rollDropTable(rng, drops) {
  const out = [];
  for (const d of drops || []) {
    if (rng() > d.chance) continue;
    const count = d.min + Math.floor(rng() * (d.max - d.min + 1));
    if (count > 0) out.push({ item: d.item, count });
  }
  return out;
}

/** Shared by enemy death and warden death: rolls a drop table into pickups. */
export function dropLoot(game, position, drops, rng = Math.random) {
  for (const { item, count } of rollDropTable(rng, drops)) {
    game.spawner?.spawnPickup?.(item, count, position);
  }
}

function hitTypeAndAmount(damage) {
  let type = 'blunt', best = -1, total = 0;
  for (const [k, v] of Object.entries(damage || {})) {
    total += v;
    if (v > best) { best = v; type = k; }
  }
  return { type, amount: total };
}

export function attackHit(def, source, multiplier = 1) {
  const { type, amount } = hitTypeAndAmount(def.damage);
  return { amount: amount * multiplier, type, stagger: def.stagger ?? 0, knockback: 2, source, crit: false };
}

/** Spawns a live enemy: mesh + damageable entity, registered with game.entities. */
export function spawnEnemy(game, enemyId, position, { hpMult = 1, dmgMult = 1 } = {}) {
  const base = getEnemy(enemyId);
  if (!base) return null;
  const scale = base.scale ?? 1;
  const mesh = createEnemyMesh(base.build, scale);
  mesh.position.copy(position);
  game.scene.add(mesh);

  const entity = {
    mesh,
    def: { ...base, hp: Math.round(base.hp * hpMult), dmgMult },
    // Simulation owns `position`; the spawner lerps `mesh.position` from
    // `prevPosition` -> `position` each render frame (same pattern as the
    // player), so the mesh is never treated as authoritative sim state.
    position: position.clone(),
    prevPosition: position.clone(),
    velocity: new THREE.Vector3(),
    facing: 0,
    prevFacing: 0,
    flashTimer: 0,
    telegraph: false,
    corpseTimer: 0,
    spawnPos: position.clone(),
    aiState: null, // filled in by ai.createAIState via the spawner
  };
  makeDamageable(entity, { hp: entity.def.hp, faction: base.faction, radius: 0.5 * scale });

  entity.takeHit = function takeHit(hit) {
    if (entity.isDead) return { amount: 0, killed: false, staggered: false, crit: false };
    const armour = entity.def.armour || 0;
    const amount = Math.max(1, (hit.amount || 0) - armour);
    entity.hp = clamp(entity.hp - amount, 0, entity.maxHp);
    entity.flashTimer = FLASH_TIME;

    let staggered = false;
    if (entity.staggered <= 0) {
      entity.stagger = clamp(entity.stagger + (hit.stagger || 0), 0, entity.maxStagger);
      if (entity.stagger >= entity.maxStagger) { entity.staggered = 2; entity.stagger = 0; staggered = true; }
    }

    if (hit.knockback && hit.source?.position) {
      const dx = entity.position.x - hit.source.position.x;
      const dz = entity.position.z - hit.source.position.z;
      const len = Math.hypot(dx, dz) || 1;
      entity.velocity.x += (dx / len) * hit.knockback;
      entity.velocity.z += (dz / len) * hit.knockback;
    }

    entity.aiState && (entity.aiState.damagedEver = true);

    if (entity.hp <= 0 && !entity.isDead) {
      entity.isDead = true;
      entity.corpseTimer = 3; // seconds the corpse lingers before despawning
      game.bus.emit('entity:killed', { entity, source: hit.source, position: entity.position.clone() });
      if (base.xp) game.progression?.gainXp?.(hitTypeAndAmount(base.damage).type, base.xp);
      dropLoot(game, entity.position, base.drops);
    }

    return { amount, killed: entity.isDead, staggered, crit: hit.crit ?? false };
  };

  game.entities.add(entity);
  return entity;
}
