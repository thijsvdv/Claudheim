import * as THREE from 'three';
import { createHeldProp, animateHeldProp } from './heldprops.js';
import { resolveBodyCollisions } from '../core/collision.js';
import { settings } from '../core/settings.js';
import { makeDamageable } from '../core/entities.js';
import { clamp, damp, angleDelta } from '../core/math.js';

// -- Tuning -----------------------------------------------------------------
const WALK_SPEED = 4;
const SPRINT_SPEED = 7;
const DEBUG_SPEED_MULT = 10;   // settings.debugMode
const CROUCH_SPEED = 2;
const SWIM_SPEED = 2.6;
const GRAVITY = 22;
const JUMP_SPEED = 6.4;
const BODY_RADIUS = 0.4;
const BODY_HEIGHT = 1.8;
const STEP_HEIGHT = 0.6;   // how tall a ledge you can walk straight onto
const JUMP_STAM_COST = 15;
const SPRINT_STAM_COST = 14; // per second
const SWIM_STAM_DRAIN = 9;   // per second, deep water
const DROWN_DPS = 10;
const STAM_REGEN = 18;       // per second
const STAM_REGEN_DELAY = 1.0;
const SLOPE_LIMIT = 50 * Math.PI / 180;
const SLIDE_ACCEL = 16;
const FACE_LAMBDA = 14;
const WATER_SURFACE_OFFSET = -0.35; // swim with chest near the surface
const WISP_LIFETIME_DAYS = 1;
const RESPAWN_INVULN = 2;

const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_FORWARD = new THREE.Vector3(0, 0, 1);
const DEFAULT_RIGHT = new THREE.Vector3(-1, 0, 0);

// Shared materials/geometries: cheap, reused across the single player instance
// but kept module-scoped anyway so a future multiplayer pass doesn't need to
// rethink allocation.
let sharedGeo = null;
function geo() {
  if (sharedGeo) return sharedGeo;
  sharedGeo = {
    torso: new THREE.CapsuleGeometry(0.22, 0.5, 4, 8),
    head: new THREE.SphereGeometry(0.17, 12, 8),
    limb: new THREE.CapsuleGeometry(0.075, 0.42, 3, 6),
    upperArm: new THREE.CapsuleGeometry(0.07, 0.14, 3, 6),
    foreArm: new THREE.CapsuleGeometry(0.062, 0.13, 3, 6),
    wisp: new THREE.IcosahedronGeometry(0.22, 0),
  };
  return sharedGeo;
}

function buildBody() {
  const g = geo();
  const clothMat = new THREE.MeshStandardMaterial({ color: 0x3d4a5c, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8b48c, roughness: 0.9 });

  const root = new THREE.Group();
  root.name = 'player';

  // The entity's origin is at its feet — the ground snap, collision and camera
  // pivot all assume that — so the hips sit a leg's length above it. The legs
  // are a 0.42 capsule with 0.075 caps hanging 0.22 below the hip pivot, which
  // puts the soles exactly on y = 0.
  const HIP_Y = 0.505;
  const SHOULDER_Y = HIP_Y + 0.62;

  const torso = new THREE.Mesh(g.torso, clothMat);
  torso.position.set(0, HIP_Y + 0.42, 0);
  torso.castShadow = true;
  root.add(torso);

  const head = new THREE.Mesh(g.head, skinMat);
  head.position.set(0, HIP_Y + 0.92, 0);
  head.castShadow = true;
  root.add(head);

  function limbPivot(x, y, mat) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(g.limb, mat);
    mesh.position.set(0, -0.22, 0);
    mesh.castShadow = true;
    pivot.add(mesh);
    return pivot;
  }

  // Arms hinge at the elbow: a chop reads as a chop only if the forearm can
  // fold on the wind-up and snap straight through the strike.
  function armPivot(x, y, mat) {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, y, 0);
    const upper = new THREE.Mesh(g.upperArm, mat);
    upper.position.set(0, -0.14, 0);
    upper.castShadow = true;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.set(0, -0.28, 0);
    shoulder.add(elbow);
    const fore = new THREE.Mesh(g.foreArm, mat);
    fore.position.set(0, -0.13, 0);
    fore.castShadow = true;
    elbow.add(fore);

    return { shoulder, elbow };
  }

  const leftLeg = limbPivot(-0.13, HIP_Y, clothMat);
  const rightLeg = limbPivot(0.13, HIP_Y, clothMat);
  const left = armPivot(-0.32, SHOULDER_Y, skinMat);
  const right = armPivot(0.32, SHOULDER_Y, skinMat);
  const leftArm = left.shoulder, rightArm = right.shoulder;
  root.add(leftLeg, rightLeg, leftArm, rightArm);

  const handAnchor = new THREE.Object3D();
  handAnchor.name = 'handAnchor';
  handAnchor.position.set(0, -0.21, 0.045);   // in the fist, not past the fingertips
  right.elbow.add(handAnchor);

  const offhandAnchor = new THREE.Object3D();
  offhandAnchor.name = 'offhandAnchor';
  offhandAnchor.position.set(0, -0.2, 0.06);
  left.elbow.add(offhandAnchor);

  root.traverse((o) => { o.userData.playerBody = true; });

  return {
    root, torso, head, leftLeg, rightLeg, leftArm, rightArm, handAnchor, offhandAnchor,
    leftElbow: left.elbow, rightElbow: right.elbow,
    materials: [clothMat, skinMat],
  };
}

function buildWispMesh() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8fd8ff, emissive: 0x2a6f8f, emissiveIntensity: 1.4,
    transparent: true, opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geo().wisp, mat);
  const light = new THREE.PointLight(0x8fd8ff, 1.2, 6);
  const group = new THREE.Group();
  group.add(mesh, light);
  return { group, mesh };
}

export function createPlayer(game) {
  const body = buildBody();
  const scratchDir = new THREE.Vector3();

  const player = {
    name: 'player',
    mesh: body.root,
    handAnchor: body.handAnchor,
    position: new THREE.Vector3(0, 0, 0),
    prevPosition: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    facing: 0,
    prevFacing: 0,
    grounded: true,
    crouching: false,
    sprinting: false,
    swimming: false,
    staminaRegenDelay: 0,
    invuln: 0,
    wisp: null,
    _walkPhase: 0,
    _platformY: -Infinity,
    _speedMag: 0,
  };

  makeDamageable(player, { hp: 100, faction: 'player', radius: 0.4 });

  // `player.stats` is the documented HUD-facing shape; hp/maxHp there are
  // accessors onto the same fields the Entity/damageable contract expects,
  // so nothing can desync the two views of health.
  const stamEitr = { stam: 100, maxStam: 100, eitr: 0, maxEitr: 0 };
  player.stats = stamEitr;
  Object.defineProperty(stamEitr, 'hp', { get: () => player.hp, set: (v) => { player.hp = v; }, enumerable: true });
  Object.defineProperty(stamEitr, 'maxHp', { get: () => player.maxHp, set: (v) => { player.maxHp = v; }, enumerable: true });

  player.spendStamina = function spendStamina(n) {
    if (n <= 0) return true;
    if (stamEitr.stam < n) return false;
    stamEitr.stam -= n;
    player.staminaRegenDelay = STAM_REGEN_DELAY;
    return true;
  };

  player.heal = function heal(n) {
    player.hp = clamp(player.hp + n, 0, player.maxHp);
  };

  player.damage = function damage(hit) {
    if (player.isDead || player.invuln > 0) return;
    const amount = Math.max(0, hit?.amount ?? 0);
    player.hp = clamp(player.hp - amount, 0, player.maxHp);
    if (hit?.knockback && hit.source?.position) {
      scratchDir.copy(player.position).sub(hit.source.position);
      scratchDir.y = 0;
      if (scratchDir.lengthSq() > 1e-6) {
        scratchDir.normalize().multiplyScalar(hit.knockback);
        player.velocity.x += scratchDir.x;
        player.velocity.z += scratchDir.z;
      }
    }
    game.bus.emit('player:damaged', { hit, hp: player.hp, maxHp: player.maxHp, position: player.position.clone() });
    if (player.hp <= 0) die();
  };

  // Satisfies the generic Entity contract (`takeHit -> HitResult`) that
  // game.entities/combat expect from anything damageable, in terms of the
  // player-specific `damage()` method documented in ARCHITECTURE.md.
  player.takeHit = function takeHit(hit) {
    const before = player.hp;
    player.damage(hit);
    return { amount: before - player.hp, killed: player.isDead, staggered: false, crit: hit?.crit ?? false };
  };

  function spawnWisp(position, marks) {
    clearWisp();
    const { group, mesh } = buildWispMesh();
    group.position.copy(position);
    game.scene.add(group);
    player.wisp = { group, mesh, position: position.clone(), marks, expiresAtDay: game.time.day + WISP_LIFETIME_DAYS };
  }

  function clearWisp() {
    if (!player.wisp) return;
    game.scene.remove(player.wisp.group);
    player.wisp = null;
  }

  function reclaimWisp() {
    if (!player.wisp) return;
    const marks = player.wisp.marks;
    game.progression?.recoverMarks?.(marks);
    game.bus.emit('player:wisp_reclaimed', { marks, position: player.wisp.position.clone() });
    clearWisp();
  }

  const HARVEST_RANGE = 3.2;

  /**
   * Berries and surface flint come up by hand; anything with a tier or a
   * chop/mine requirement needs a swing with the right tool instead.
   */
  function tryHandHarvest() {
    const res = game.world?.resources;
    if (!res?.near || !res?.damage) return;
    let best = null, bestD = Infinity;
    for (const node of res.near(player.position, HARVEST_RANGE) ?? []) {
      if (node.tier !== 0 || node.tool !== 'pick') continue;
      const d = player.position.distanceToSquared(node.position);
      if (d < bestD) { bestD = d; best = node; }
    }
    if (best) res.damage(best, best.hp, 'hand');
  }

  function respawnPoint() {
    // An Ember Hearth binds you when it's placed (systems/building.js sets
    // player.bindPoint), and the bind survives a save.
    const bind = player.bindPoint;
    if (bind) {
      const y = game.world?.heightAt?.(bind.x, bind.z) ?? bind.y;
      return new THREE.Vector3(bind.x, y, bind.z);
    }
    const y = game.world?.heightAt?.(0, 0) ?? 0;
    return new THREE.Vector3(0, y, 0);
  }

  function die() {
    if (player.isDead) return;
    player.isDead = true;
    const deathPos = player.position.clone();
    const marks = game.progression?.dropMarks?.() ?? 0;
    if (marks > 0) spawnWisp(deathPos, marks);
    game.bus.emit('player:died', { position: deathPos, marks });

    const spawn = respawnPoint();
    player.position.copy(spawn);
    player.prevPosition.copy(spawn);
    player.velocity.set(0, 0, 0);
    player.hp = Math.max(1, Math.round(player.maxHp * 0.5));
    stamEitr.stam = stamEitr.maxStam;
    player.invuln = RESPAWN_INVULN;
    player.isDead = false;
  }

  function sampleGround(x, z) {
    const s = game.world?.sampleGround?.(x, z);
    if (s) return s;
    return { y: game.world?.heightAt?.(x, z) ?? 0, normal: UP, biome: 'shore', slope: 0 };
  }

  player.init = function init() {
    const spawn = respawnPoint();
    player.position.copy(spawn);
    player.prevPosition.copy(spawn);
    game.scene.add(body.root);
    game.entities.add(player);
  };

  /**
   * Solid-world response, run after the position integrates: trees, rocks and
   * build pieces. `player._platformY` feeds back into the next step's ground
   * test so you can stand, and jump, on your own roof.
   */
  function resolveCollisions() {
    const platform = resolveBodyCollisions(game, player, {
      radius: BODY_RADIUS, height: BODY_HEIGHT, step: STEP_HEIGHT,
    });
    player._platformY = platform;
    const pos = player.position;
    if (platform > -Infinity && pos.y < platform && pos.y > platform - STEP_HEIGHT) {
      pos.y = platform;
      if (player.velocity.y < 0) player.velocity.y = 0;
      player.grounded = true;
    }
  }

  player.fixedUpdate = function fixedUpdate(dt) {
    player.prevPosition.copy(player.position);
    player.prevFacing = player.facing;

    if (player.invuln > 0) player.invuln -= dt;

    // Eitr ceiling is unlocked via the Vow-Tree "witness" node; clamp current
    // eitr down if the node were ever revoked (e.g. a future respec).
    stamEitr.maxEitr = game.progression?.effects?.eitrMax ?? 0;
    if (stamEitr.eitr > stamEitr.maxEitr) stamEitr.eitr = stamEitr.maxEitr;

    if (player.staminaRegenDelay > 0) player.staminaRegenDelay -= dt;
    else if (stamEitr.stam < stamEitr.maxStam) stamEitr.stam = clamp(stamEitr.stam + STAM_REGEN * dt, 0, stamEitr.maxStam);

    if (player.wisp && game.time.day >= player.wisp.expiresAtDay) clearWisp();
    if (player.wisp && !player.isDead) {
      const d = player.position.distanceTo(player.wisp.position);
      if (d < 1.6 && game.input.wasPressed('interact')) reclaimWisp();
    }
    if (!player.isDead && game.input.wasPressed('interact')) tryHandHarvest();

    const input = game.input;
    const rig = game.cameraRig;
    const fwd = rig?.forward ?? DEFAULT_FORWARD;
    const right = rig?.right ?? DEFAULT_RIGHT;

    let mx = 0, mz = 0;
    if (input.isDown('forward')) { mx += fwd.x; mz += fwd.z; }
    if (input.isDown('back')) { mx -= fwd.x; mz -= fwd.z; }
    if (input.isDown('right')) { mx += right.x; mz += right.z; }
    if (input.isDown('left')) { mx -= right.x; mz -= right.z; }
    const moveLen = Math.hypot(mx, mz);
    if (moveLen > 1e-4) { mx /= moveLen; mz /= moveLen; }

    const ground = sampleGround(player.position.x, player.position.z);
    const isWater = game.world?.isWater?.(player.position.x, player.position.z) ?? false;
    const depth = isWater ? -(game.world?.heightAt?.(player.position.x, player.position.z) ?? 0) : 0;
    player.swimming = isWater && depth > 1.4;

    player.crouching = input.isDown('crouch') && !player.swimming;
    let speed = player.crouching ? CROUCH_SPEED : WALK_SPEED;
    player.sprinting = false;
    if (!player.swimming && moveLen > 0 && input.isDown('sprint') && !player.crouching) {
      const mult = game.progression?.effects?.sprintCostMult ?? 1;
      if (player.spendStamina(SPRINT_STAM_COST * mult * dt)) {
        speed = SPRINT_SPEED * (settings.debugMode ? DEBUG_SPEED_MULT : 1);
        player.sprinting = true;
      }
    }
    if (player.swimming) speed = SWIM_SPEED;

    player.velocity.x = mx * speed;
    player.velocity.z = mz * speed;
    player._speedMag = moveLen * speed;

    if (player.swimming) {
      const spent = player.spendStamina(SWIM_STAM_DRAIN * dt);
      if (!spent) player.damage({ amount: DROWN_DPS * dt, type: 'blunt', stagger: 0, knockback: 0, source: null });
      player.velocity.y = damp(player.velocity.y, 0, 6, dt);
      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
      const surfaceY = 0 + WATER_SURFACE_OFFSET;
      player.position.y = damp(player.position.y, surfaceY, 4, dt);
      player.grounded = false;
    } else {
      const onSlope = ground.slope > SLOPE_LIMIT;
      // Your own floors count as ground, so you can stand and jump on them.
      const groundY = Math.max(ground.y, player._platformY ?? -Infinity);
      const atGround = player.position.y <= groundY + 0.05;

      if (atGround && !onSlope) {
        player.grounded = true;
        player.velocity.y = 0;
        player.position.y = groundY;
        if (input.wasPressed('jump') && player.spendStamina(JUMP_STAM_COST)) {
          player.velocity.y = JUMP_SPEED;
          player.grounded = false;
        }
      } else {
        player.grounded = false;
        player.velocity.y -= GRAVITY * dt;
      }

      if (onSlope && ground.normal) {
        // Slide downhill: the normal's horizontal component points away from
        // the slope's uphill side, which is exactly the direction we want.
        player.velocity.x += ground.normal.x * SLIDE_ACCEL * dt;
        player.velocity.z += ground.normal.z * SLIDE_ACCEL * dt;
      }

      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
      player.position.y += player.velocity.y * dt;

      const groundAfter = sampleGround(player.position.x, player.position.z);
      if (player.position.y < groundAfter.y && groundAfter.slope <= SLOPE_LIMIT) {
        player.position.y = groundAfter.y;
        player.velocity.y = 0;
      }
    }

    resolveCollisions();

    if (moveLen > 1e-3 && !player.swimming) {
      const targetYaw = Math.atan2(mx, mz);
      player.facing += angleDelta(player.facing, targetYaw) * (1 - Math.exp(-FACE_LAMBDA * dt));
    }

    player._walkPhase += dt * player._speedMag * 2.2;
  };

  // ---- held props ----
  // Rebuilt only when the equipped id actually changes; the meshes themselves
  // are shared geometry, so a swap is just a reparent.
  let heldId = null, heldProp = null;
  let offhandId = null, offhandProp = null;

  // The shoulder cam moves the body off the crosshair; this takes care of the
  // rest, since a wall ghost at close reach still lands behind the torso.
  let bodyFade = 1;
  function syncBuildFade(dt) {
    const want = game.building?.buildMode ? 0.3 : 1;
    if (Math.abs(bodyFade - want) < 0.005 && bodyFade === want) return;
    bodyFade += (want - bodyFade) * clamp((dt ?? 0) * 8, 0, 1);
    if (Math.abs(bodyFade - want) < 0.01) bodyFade = want;
    for (const mat of body.materials) {
      mat.transparent = bodyFade < 0.999;
      mat.opacity = bodyFade;
      mat.depthWrite = bodyFade > 0.999;
    }
  }

  function syncHeldProps() {
    const inv = game.inventory;

    const mainId = inv?.equipped?.id ?? null;
    if (mainId !== heldId) {
      if (heldProp) body.handAnchor.remove(heldProp);
      heldProp = mainId ? createHeldProp(mainId) : null;
      if (heldProp) body.handAnchor.add(heldProp);
      heldId = mainId;
    }

    // A two-handed thing in the main hand hides the shield; nothing here is
    // two-handed yet, so the shield rides whenever it's equipped.
    const shieldId = inv?.equipment?.shield ?? null;
    if (shieldId !== offhandId) {
      if (offhandProp) body.offhandAnchor.remove(offhandProp);
      offhandProp = shieldId ? createHeldProp(shieldId) : null;
      if (offhandProp) body.offhandAnchor.add(offhandProp);
      offhandId = shieldId;
    }
  }

  // ---- swing animation ----------------------------------------------------
  // One pose per phase per weapon shape; the phase timer drives the blend, so
  // the body always agrees with the hitbox that combat.js is running.
  // sx: shoulder pitch (+ back and up), sz: shoulder roll (+ outward),
  // el: elbow fold, tw: torso twist.
  const REST_POSE = { sx: 0, sz: 0, el: 0, tw: 0 };
  const SWING_POSES = {
    overhead: {
      // Straight up over the head, elbow cocked — then down through the target.
      // Reaching backwards reads as a wind-up for a throw, not a chop.
      windup: { sx: 2.95, sz: 0.1, el: -1.0, tw: 0.16 },
      hit: { sx: -1.15, sz: 0.04, el: -0.05, tw: -0.22 },
    },
    slash: {
      windup: { sx: -0.7, sz: 0.95, el: -1.2, tw: 0.55 },
      hit: { sx: -1.15, sz: -0.85, el: -0.2, tw: -0.6 },
    },
    thrust: {
      windup: { sx: -1.1, sz: 0.08, el: -1.8, tw: 0.4 },
      hit: { sx: -1.5, sz: 0, el: -0.05, tw: -0.18 },
    },
  };
  const STYLE_BY_CLASS = {
    axe: 'overhead', pick: 'overhead', mace: 'overhead', unarmed: 'overhead',
    sword: 'slash', spear: 'thrust', bow: 'thrust',
  };
  const DRAW_POSE = { sx: -0.55, sz: 0.35, el: -2.0, tw: 0.42, offhand: -1.5, offElbow: -0.15 };
  const BLOCK_POSE = { sx: -0.35, sz: 0.15, el: -1.1, tw: 0.2, offhand: -1.3, offElbow: -0.85 };

  const lerp = (a, b, k) => a + (b - a) * k;
  const mixPose = (a, b, k) => ({
    sx: lerp(a.sx, b.sx, k), sz: lerp(a.sz, b.sz, k),
    el: lerp(a.el, b.el, k), tw: lerp(a.tw, b.tw, k),
    offhand: lerp(a.offhand ?? 0, b.offhand ?? 0, k),
    offElbow: lerp(a.offElbow ?? 0, b.offElbow ?? 0, k),
  });

  function swingPose(s) {
    const set = SWING_POSES[STYLE_BY_CLASS[s.weapon?.class] ?? 'overhead'];
    const move = s.move ?? {};
    if (s.phase === 'windup') {
      const t = clamp(s.t / Math.max(0.01, move.windup ?? 0.2), 0, 1);
      return mixPose(REST_POSE, set.windup, 1 - (1 - t) * (1 - t));   // ease out
    }
    if (s.phase === 'active') {
      const t = clamp(s.t / Math.max(0.01, move.active ?? 0.1), 0, 1);
      return mixPose(set.windup, set.hit, Math.pow(t, 0.42));          // snap through, front-loaded
    }
    const t = clamp(s.t / Math.max(0.01, move.recover ?? 0.25), 0, 1);
    return mixPose(set.hit, REST_POSE, t * t * (3 - 2 * t));           // ease in-out
  }

  let poseWeight = 0;
  let lastPose = REST_POSE;

  function poseArms(dt, walkSwing) {
    const combat = game.combat;
    let target = null;
    const swing = combat?.swingState?.(player);
    if (swing) target = swingPose(swing);
    else if (combat?.draw?.active) target = DRAW_POSE;
    else if (combat?.block?.active && game.inventory?.equipment?.shield) target = BLOCK_POSE;

    if (target) lastPose = target;
    poseWeight = damp(poseWeight, target ? 1 : 0, 16, dt);

    const w = poseWeight;
    if (w < 0.002) return;
    const pose = target ?? lastPose;

    // Walk cycle stays underneath, so a swing mid-run still looks like running.
    body.rightArm.rotation.x = lerp(walkSwing * 0.8, pose.sx, w);
    body.rightArm.rotation.z = lerp(0, pose.sz, w);
    body.rightElbow.rotation.x = lerp(0, pose.el, w);
    body.leftArm.rotation.x = lerp(-walkSwing * 0.8, pose.offhand ?? -pose.sx * 0.22, w);
    body.leftElbow.rotation.x = lerp(0, pose.offElbow ?? -0.15, w);
    body.root.rotation.y += pose.tw * w;
  }

  player.update = function update(dt, _unusedGame, alpha) {
    syncHeldProps();
    syncBuildFade(dt);
    if (heldProp) animateHeldProp(heldProp, game.time?.elapsed ?? 0);
    body.root.position.lerpVectors(player.prevPosition, player.position, clamp(alpha ?? 1, 0, 1));
    const yaw = player.prevFacing + angleDelta(player.prevFacing, player.facing) * clamp(alpha ?? 1, 0, 1);
    body.root.rotation.y = yaw;

    const amp = player.swimming ? 0.2 : player.crouching ? 0.25 : player.sprinting ? 0.75 : 0.5;
    const swing = player._speedMag > 0.05 ? Math.sin(player._walkPhase) * amp : 0;
    body.leftLeg.rotation.x = swing;
    body.rightLeg.rotation.x = -swing;
    body.leftArm.rotation.x = -swing * 0.8;
    body.rightArm.rotation.x = swing * 0.8;
    body.leftArm.rotation.z = 0;
    body.rightArm.rotation.z = 0;
    body.leftElbow.rotation.x = 0;
    body.rightElbow.rotation.x = 0;
    poseArms(dt, swing);

    const crouchScale = player.crouching ? 0.82 : 1;
    body.root.scale.set(1, crouchScale, 1);

    if (player.wisp) {
      player.wisp.group.position.y = player.wisp.position.y + 0.4 + Math.sin(game.time.elapsed * 2) * 0.12;
      player.wisp.group.rotation.y += dt * 0.8;
    }
  };

  player.serialize = function serialize() {
    return {
      position: player.position.toArray(),
      facing: player.facing,
      hp: player.hp,
      stam: stamEitr.stam,
      eitr: stamEitr.eitr,
      bindPoint: player.bindPoint ? player.bindPoint.toArray() : null,
      wisp: player.wisp
        ? { position: player.wisp.position.toArray(), marks: player.wisp.marks,
            expiresAtDay: player.wisp.expiresAtDay }
        : null,
    };
  };

  player.hydrate = function hydrate(data) {
    if (!data) return;
    if (Array.isArray(data.position)) {
      player.position.fromArray(data.position);
      player.prevPosition.copy(player.position);
    }
    if (Number.isFinite(data.facing)) { player.facing = data.facing; player.prevFacing = data.facing; }
    if (Number.isFinite(data.hp)) player.hp = clamp(data.hp, 1, player.maxHp);
    if (Number.isFinite(data.stam)) stamEitr.stam = clamp(data.stam, 0, stamEitr.maxStam);
    if (Number.isFinite(data.eitr)) stamEitr.eitr = Math.max(0, data.eitr);
    player.bindPoint = Array.isArray(data.bindPoint)
      ? new THREE.Vector3().fromArray(data.bindPoint) : null;
    player.velocity.set(0, 0, 0);
    player.isDead = false;
    if (data.wisp?.position) {
      spawnWisp(new THREE.Vector3().fromArray(data.wisp.position), data.wisp.marks ?? 0);
      if (Number.isFinite(data.wisp.expiresAtDay)) player.wisp.expiresAtDay = data.wisp.expiresAtDay;
    } else {
      clearWisp();
    }
  };

  player.dispose = function dispose() {
    game.scene.remove(body.root);
    clearWisp();
    game.entities.remove(player);
  };

  return player;
}
