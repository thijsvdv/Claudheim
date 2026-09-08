import * as THREE from 'three';
import { getWeapon, BLOCK } from '../data/weapons.js';
import { getItem } from '../data/items.js';
import { skillBonus, skillStaminaMult } from '../data/skills.js';
import { inArc, clamp } from '../core/math.js';
import { settings } from '../core/settings.js';

// ---- Tunable balance constants (no numeric contract for these exists in the
// data files, so they live here where combat owns the feel). ----
const CRIT_MULT = 2.0;
const CRIT_BASE_CHANCE = 0.05;
const CRIT_LEVEL_BONUS = 0.002; // +0.2%/level, up to +20% at level 100
const STAGGER_DURATION = 2.0;   // seconds a filled meter keeps a target down
const STAGGER_DRAIN = 15;       // meter points/second, drains when not staggered
const RIPOSTE_DURATION = 1.5;
const BLEED_DURATION = 5;
const BLEED_DPS = 3;
const BLOCK_STAMINA_RATIO = 0.5; // fraction of incoming damage spent as stamina when blocking
const GRAVITY = 9.8;
const ARROW_SPEED_FLOOR = 0.5;  // a bare-tap shot still leaves the string at half draw speed
const RUNE_BOLT_SPEED = 24;
const TRAIL_SEGMENTS = 8;
const TRAIL_FADE_TIME = 0.25;
const SPARK_LIFE = 0.35;
const DMG_NUMBER_LIFE = 0.9;
const SHAKE_POS = 0.12;
const SHAKE_ROT = 0.01;
const SHAKE_DECAY = 2.2;
const MIN_DRAW_TO_FIRE = 0.15; // seconds; below this a release is treated as a cancel

/** The type with the largest single contribution in a weapon's damage bag. */
function dominantDamageType(bag) {
  let best = 'blunt';
  let bestV = -Infinity;
  for (const [type, v] of Object.entries(bag || {})) {
    if (v > bestV) { bestV = v; best = type; }
  }
  return best;
}

function sparkColourFor(type) {
  switch (type) {
    case 'fire': return 0xff8c42;
    case 'frost': return 0x8fd0e6;
    case 'poison': return 0x9acb5a;
    case 'spirit': return 0xd8c8f0;
    case 'pierce': return 0xe8e4d8;
    default: return 0xfff2d8;
  }
}

/**
 * Horizontal facing as a unit XZ vector. The player's facing comes from the
 * camera rig's aim ray (mouse look); other attackers fall back to a `forward`
 * vector or a yaw field, since the enemy AI's actual transform shape is owned
 * by the entities agent and not fixed by ARCHITECTURE.md.
 */
function getForwardXZ(game, attacker) {
  if (attacker === game.player) {
    const ray = game.cameraRig?.aimRay?.();
    if (ray?.direction) {
      const len = Math.hypot(ray.direction.x, ray.direction.z) || 1e-6;
      return [ray.direction.x / len, ray.direction.z / len];
    }
  }
  if (attacker.forward && (attacker.forward.x || attacker.forward.z)) {
    const f = attacker.forward;
    const len = Math.hypot(f.x, f.z) || 1e-6;
    return [f.x / len, f.z / len];
  }
  const yaw = attacker.rotation?.y ?? attacker.yaw ?? 0;
  return [Math.sin(yaw), Math.cos(yaw)];
}

/**
 * Pick the moveset entry for a swing. Light attacks combo through
 * `weapon.light[]`; a 3rd+ step is gated behind proficiency level 25 per
 * VISION section 4 ("a third combo swing at 25").
 */
// Playtest multiplier for the player's own attacks, behind Settings > Debug mode.
const DEBUG_DAMAGE_MULT = 10;
const playerDamageMult = () => (settings.debugMode ? DEBUG_DAMAGE_MULT : 1);

const _handTmp = new THREE.Vector3();
/** World position of an entity's hand, falling back to its feet. */
function handWorld(entity) {
  if (entity?.handAnchor?.getWorldPosition) return entity.handAnchor.getWorldPosition(_handTmp);
  return _handTmp.copy(entity.position);
}

function pickMove(weapon, kind, comboIndex, level) {
  if (kind === 'heavy') return weapon.heavy || weapon.light?.[0] || null;
  if (kind === 'thrust') return weapon.thrust || weapon.heavy || weapon.light?.[weapon.light.length - 1] || null;
  const arr = weapon.light || [];
  if (!arr.length) return null;
  const cap = arr.length >= 3 && level < 25 ? 2 : arr.length;
  return arr[comboIndex % cap];
}

function rollCrit(level, guaranteed) {
  if (guaranteed) return true;
  return Math.random() < CRIT_BASE_CHANCE + level * CRIT_LEVEL_BONUS;
}

class Combat {
  constructor(game) {
    this.name = 'combat';
    this.game = game;

    this._swings = new Map();      // attacker -> swing state
    this._bleeds = new Map();      // target -> { remaining, dps }
    this._killed = new WeakSet();  // targets we've already emitted entity:killed for

    this.arrows = [];
    this.runeBolts = [];
    this.sparks = [];
    this.damageNumbers = [];
    this.fadingTrails = [];

    this.block = { active: false, parryTimer: 0 };
    this.draw = { active: false, t: 0, weapon: null };
    this.runeCast = null;
    this.riposteWindow = 0;
    this.shakeTrauma = 0;
    this._shakeOffset = new THREE.Vector3();

    this._sparkTex = null;
    this._arrowGeo = null;
    this._arrowMat = null;
    this._runeGeo = null;
    this._runeMats = null;
  }

  init(game) {
    game.debug?.('combat: ready');
  }

  // ---------------------------------------------------------------- public

  /** Screen-shake impulse; amount is roughly "how hard", clamped internally. */
  shake(amount) {
    this.shakeTrauma = clamp(this.shakeTrauma + amount, 0, 1);
  }

  /**
   * Begin (or combo-continue) a melee swing for `attacker`. Returns false if
   * the attack was refused (already mid-swing, or insufficient stamina).
   */
  swing({ attacker, weapon, kind = 'light' }) {
    if (!attacker || !weapon) return false;
    const existing = this._swings.get(attacker);
    if (existing && (existing.phase === 'windup' || existing.phase === 'active')) return false;

    const level = this._skillLevel(weapon.skill);
    let comboIndex = 0;
    if (existing && existing.phase === 'recover' && existing.kind === 'light' && kind === 'light') {
      comboIndex = existing.comboIndex + 1;
    }
    const move = pickMove(weapon, kind, comboIndex, level);
    if (!move) return false;

    const staminaCost = weapon.stamina * (move.staminaMult ?? 1) * skillStaminaMult(level)
      * (this._effects().staminaCostMult ?? 1);
    if (!this._spendStamina(attacker, staminaCost)) return false;

    if (existing?.trail) this._retireTrail(existing.trail);

    this._swings.set(attacker, {
      attacker, weapon, kind, move, comboIndex, level,
      phase: 'windup', t: 0, hitSet: new Set(),
      trail: this._makeTrail(),
    });
    return true;
  }

  /** The swing an entity is part-way through, or null. Read by the animator. */
  swingState(entity) { return this._swings.get(entity) ?? null; }

  /** Generic hit resolution: armour, block/parry, stagger, VFX, death, XP. */
  applyHit(target, hit) {
    const game = this.game;
    if (!target || target.isDead || !hit) return null;

    if (target === game.player && this.block.active) {
      return this._resolveBlockedHit(target, hit);
    }

    let amount = hit.amount;
    const armour = (target.armour ?? 0) * (1 - (hit.armourPierce ?? 0));
    amount = Math.max(amount - armour, amount * 0.1);
    if (target.staggered > 0) amount *= 2;

    this._dealDamage(target, { ...hit, amount });
    this._applyStagger(target, hit.stagger ?? 0);

    const effects = this._effects();
    if (hit.type === 'slash' && effects.bleed && hit.source === game.player) {
      this._bleeds.set(target, { remaining: BLEED_DURATION, dps: BLEED_DPS });
    }
    this._applyKnockback(target, hit);

    this._spawnSpark(target.position, sparkColourFor(hit.type));
    this._spawnDamageNumber(target.position, amount, !!hit.crit);
    this.shake(clamp(amount / 60, 0.02, 0.5) * (target === game.player ? 1.6 : 1));

    if (hit.skill && hit.source === game.player) {
      game.progression?.gainXp?.(hit.skill, Math.max(1, amount * 0.4));
    }

    if ((target.hp <= 0 || target.isDead) && !this._killed.has(target)) {
      this._killed.add(target);
      target.isDead = true;
      game.bus.emit('entity:killed', { entity: target, source: hit.source });
    }
    return { amount, crit: !!hit.crit };
  }

  // -------------------------------------------------------------- lifecycle

  fixedUpdate(dt) {
    this._handlePlayerControl(dt);
    this._advanceSwings(dt);
    this._advanceRanged(dt);
    this._advanceRune(dt);
    this._decayEntities(dt);
    this._decayBleeds(dt);
  }

  update(dt) {
    this._updateTrails(dt);
    this._updateSparks(dt);
    this._updateDamageNumbers(dt);
    this._updateShake(dt);
  }

  dispose() {
    const scene = this.game.scene;
    for (const s of this.sparks) { scene?.remove(s.sprite); s.mat.dispose(); }
    for (const d of this.damageNumbers) { scene?.remove(d.sprite); d.mat.dispose(); d.tex.dispose(); }
    for (const f of this.fadingTrails) { scene?.remove(f.line); f.geo.dispose(); f.mat.dispose(); }
    for (const a of this.arrows) scene?.remove(a.mesh);
    for (const b of this.runeBolts) scene?.remove(b.mesh);
    for (const s of this._swings.values()) if (s.trail) { scene?.remove(s.trail.line); s.trail.geo.dispose(); s.trail.mat.dispose(); }
    this._arrowGeo?.dispose(); this._arrowMat?.dispose();
    this._runeGeo?.dispose();
    if (this._runeMats) for (const m of Object.values(this._runeMats)) m.dispose();
    this.sparks.length = 0; this.damageNumbers.length = 0; this.fadingTrails.length = 0;
    this.arrows.length = 0; this.runeBolts.length = 0; this._swings.clear();
  }

  // ------------------------------------------------------------- internals

  _skillLevel(skillId) { return skillId ? (this.game.progression?.level?.(skillId) ?? 0) : 0; }
  _effects() { return this.game.progression?.effects ?? {}; }

  _spendStamina(attacker, cost) {
    if (!(cost > 0)) return true;
    if (typeof attacker.spendStamina === 'function') return attacker.spendStamina(cost);
    return true; // non-player attackers aren't stamina-gated in this slice
  }

  _findEquipped(kind) {
    const inv = this.game.inventory;
    if (!inv?.slots) return null;
    for (const stack of inv.slots) {
      const def = stack && getItem(stack.id);
      if (def?.kind === kind) return def;
    }
    return null;
  }
  _equippedShield() { return this._findEquipped('shield'); }
  _equippedRune() { return this._findEquipped('rune'); }

  _dealDamage(target, hit) {
    if (typeof target.damage === 'function') target.damage(hit);
    else if (typeof target.takeHit === 'function') target.takeHit(hit);
    else target.hp = (target.hp ?? 0) - hit.amount;
  }

  _applyStagger(target, amount) {
    if (!amount || !(target.maxStagger > 0)) return;
    target.stagger = (target.stagger ?? 0) + amount;
    if (target.stagger >= target.maxStagger) {
      target.stagger = 0;
      target.staggered = STAGGER_DURATION;
    }
  }

  _applyKnockback(target, hit) {
    if (!hit.knockback || !target.velocity?.addScaledVector) return;
    const src = hit.source?.position;
    if (!src) return;
    const dx = target.position.x - src.x, dz = target.position.z - src.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    target.velocity.addScaledVector(new THREE.Vector3(dx / len, 0, dz / len), hit.knockback);
  }

  _resolveBlockedHit(target, hit) {
    const parried = this.block.parryTimer > 0;
    if (parried) {
      this._onParry(hit);
      this._spawnSpark(target.position, 0xdfe8ef);
      return { amount: 0, parried: true };
    }
    const shield = this._equippedShield();
    const shieldArmour = shield?.block?.armour ?? 0;
    const staminaMult = shield?.block?.staminaMult ?? 1;
    const blockCost = hit.amount * BLOCK_STAMINA_RATIO * staminaMult;
    const held = this._spendStamina(target, blockCost);
    const mitigated = Math.max(hit.amount - shieldArmour, hit.amount * 0.1);
    const chip = mitigated * (BLOCK.chipRatio ?? 0.15);
    const through = held ? chip : hit.amount; // stamina break -> block fails, full damage
    this._dealDamage(target, { ...hit, amount: through });
    this._spawnSpark(target.position, 0xb5c4cf);
    this.shake(clamp(through / 60, 0.02, 0.3));
    return { amount: through, blocked: true };
  }

  _onParry(hit) {
    const game = this.game;
    const shield = this._equippedShield();
    const bonus = (shield?.block?.parryBonus ?? 1) * (BLOCK.parryStaggerMult ?? 2);
    if (hit.source) this._applyStagger(hit.source, (hit.stagger ?? 0) * bonus);
    if (game.progression?.has?.('riposte')) this.riposteWindow = RIPOSTE_DURATION;
    this.block.parryTimer = 0;
    this.shake(0.25);
  }

  // -------------------------------------------------------- player control

  _handlePlayerControl(dt) {
    const game = this.game;
    const player = game.player;
    const input = game.input;
    if (!player || !input) return;

    const equipped = game.inventory?.equipped ?? null;
    const weapon = getWeapon(equipped?.weapon || 'fists');

    this._updateBlock(dt);
    if (weapon.ranged) this._updateRangedInput(dt, player, weapon);
    else this._updateMeleeInput(player, weapon);
    this._updateRuneInput(dt, player);
  }

  _updateBlock(dt) {
    const input = this.game.input;
    const shield = this._equippedShield();
    if (!shield) { this.block.active = false; this.block.parryTimer = 0; }
    else {
      if (input.wasPressed('block')) this.block.parryTimer = BLOCK.parryWindow;
      else if (this.block.parryTimer > 0) this.block.parryTimer = Math.max(0, this.block.parryTimer - dt);
      this.block.active = input.isDown('block');
    }
    if (this.riposteWindow > 0) this.riposteWindow = Math.max(0, this.riposteWindow - dt);
  }

  _updateMeleeInput(player, weapon) {
    if (this.block.active) return;
    const input = this.game.input;
    if (input.mouseWasPressed(0)) this.swing({ attacker: player, weapon, kind: 'light' });
    else if (input.mouseWasPressed(2)) this.swing({ attacker: player, weapon, kind: 'heavy' });
  }

  _updateRangedInput(dt, player, weapon) {
    const input = this.game.input;
    const ammoId = weapon.ranged.ammo;
    const hasAmmo = (this.game.inventory?.count?.(ammoId) ?? 0) > 0;

    if (input.mouse(0) && hasAmmo) {
      if (!this.draw.active) { this.draw.active = true; this.draw.t = 0; this.draw.weapon = weapon; }
      this.draw.t = Math.min(weapon.ranged.drawTime, this.draw.t + dt);
      const cost = weapon.ranged.drainPerSec * dt * (this._effects().staminaCostMult ?? 1);
      if (!this._spendStamina(player, cost)) { this.draw.active = false; this.draw.t = 0; }
    } else if (this.draw.active) {
      const completion = this.draw.t / weapon.ranged.drawTime;
      if (this.draw.t >= MIN_DRAW_TO_FIRE && hasAmmo) this._fireArrow(player, weapon, clamp(completion, 0, 1));
      this.draw.active = false; this.draw.t = 0;
    }
  }

  _updateRuneInput(dt, player) {
    const game = this.game;
    const input = game.input;
    if (this.runeCast) {
      this.runeCast.t += dt;
      if (this.runeCast.t >= this.runeCast.rune.cast) this._releaseRune();
      return;
    }
    if (!input.wasPressed('rune')) return;
    if (!game.progression?.has?.('witness')) return;
    const runeItem = this._equippedRune();
    if (!runeItem) return;
    const cost = runeItem.rune.eitr * (this._effects().runeCostMult ?? 1);
    if (!this._spendEitr(cost)) return;
    this.runeCast = { t: 0, rune: runeItem.rune, player };
  }

  _spendEitr(cost) {
    const player = this.game.player;
    if (!player) return false;
    if (typeof player.spendEitr === 'function') return player.spendEitr(cost);
    if (player.stats && player.stats.eitr >= cost) { player.stats.eitr -= cost; return true; }
    return false;
  }

  _releaseRune() {
    const { rune, player } = this.runeCast;
    this.runeCast = null;
    const game = this.game;
    const ray = game.cameraRig?.aimRay?.();
    const dir = ray?.direction ? ray.direction.clone() : new THREE.Vector3(0, 0, -1);
    const mesh = this._makeRuneBolt(rune.type);
    mesh.position.copy(handWorld(player));
    this.runeBolts.push({
      mesh, velocity: dir.multiplyScalar(RUNE_BOLT_SPEED), life: (rune.range ?? 20) / RUNE_BOLT_SPEED,
      rune, source: player,
    });
    game.scene?.add(mesh);
  }

  // ------------------------------------------------------------ melee sim

  _advanceSwings(dt) {
    for (const [attacker, s] of this._swings) {
      s.t += dt;
      if (s.phase === 'windup') {
        if (s.t >= s.move.windup) { s.phase = 'active'; s.t = 0; this._updateTrailGeometry(s); }
      } else if (s.phase === 'active') {
        this._resolveMeleeHits(attacker, s);
        if (s.t >= s.move.active) { s.phase = 'recover'; s.t = 0; }
      } else if (s.phase === 'recover') {
        if (s.t >= s.move.recover) {
          this._swings.delete(attacker);
          this._retireTrail(s.trail);
        }
      }
    }
  }

  _resolveMeleeHits(attacker, s) {
    const game = this.game;
    const { weapon, move, hitSet } = s;
    const [fx, fz] = getForwardXZ(game, attacker);
    const pos = attacker.position;

    const candidates = game.entities?.near(pos, move.reach,
      (e) => e !== attacker && (attacker.faction == null || e.faction == null || e.faction !== attacker.faction)) ?? [];
    for (const target of candidates) {
      if (hitSet.has(target.id)) continue;
      if (!inArc(pos.x, pos.z, fx, fz, target.position.x, target.position.z, move.arc)) continue;
      hitSet.add(target.id);
      this.applyHit(target, this._buildMeleeHit(attacker, s, target));
    }

    if (weapon.tool && game.world?.resources?.near) {
      const toolKey = Object.keys(weapon.tool)[0];
      const nodes = game.world.resources.near(pos, move.reach) ?? [];
      for (const node of nodes) {
        const key = `node:${node.chunkKey ?? node.id}`;
        if (hitSet.has(key)) continue;
        if (!inArc(pos.x, pos.z, fx, fz, node.position.x, node.position.z, move.arc)) continue;
        hitSet.add(key);
        const amount = this._computeRawDamage(weapon, move, s.level);
        const result = game.world.resources.damage(node, amount, toolKey);
        game.bus.emit('resource:hit', { node, amount, blocked: result?.blocked, by: attacker });
        if (result?.destroyed) this._spawnSpark(node.position, 0xd9c9a8);
        if (weapon.skill && attacker === game.player) {
          game.progression?.gainXp?.(weapon.skill, Math.max(1, amount * 0.15));
        }
      }
    }
  }

  _computeRawDamage(weapon, move, level) {
    let base = 0;
    for (const v of Object.values(weapon.damage || {})) base += v;
    base *= move?.damageMult ?? 1;
    base *= skillBonus(level);
    return base;
  }

  _buildMeleeHit(attacker, s, target) {
    const { weapon, move, kind, level } = s;
    const game = this.game;
    const effects = this._effects();
    let amount = this._computeRawDamage(weapon, move, level);

    if (attacker.stats && effects.rageThreshold != null) {
      const frac = attacker.stats.hp / (attacker.stats.maxHp || 1);
      if (frac <= effects.rageThreshold) amount *= effects.rageDamage ?? 1;
    }

    if (attacker === game.player) amount *= playerDamageMult();

    const guaranteedCrit = attacker === game.player && this.riposteWindow > 0;
    const crit = guaranteedCrit || rollCrit(level, false);
    if (crit) { amount *= CRIT_MULT; if (guaranteedCrit) this.riposteWindow = 0; }

    let stagger = (move.stagger ?? weapon.stagger ?? 0) * (move.staggerMult ?? 1);
    if (kind === 'heavy') stagger *= effects.heavyStaggerMult ?? 1;

    return {
      amount, type: dominantDamageType(weapon.damage), stagger,
      knockback: (weapon.knockback ?? 0) * (move.knockbackMult ?? 1),
      source: attacker, crit, skill: weapon.skill, armourPierce: weapon.armourPierce ?? 0,
    };
  }

  // ----------------------------------------------------------- projectiles

  _fireArrow(attacker, weapon, completion) {
    const game = this.game;
    game.inventory?.remove?.(weapon.ranged.ammo, 1);
    const origin = handWorld(attacker);
    const ray = game.cameraRig?.aimRay?.();
    const dir = ray?.direction ? ray.direction.clone() : new THREE.Vector3(0, 0, -1);
    const speed = weapon.ranged.speed * (ARROW_SPEED_FLOOR + (1 - ARROW_SPEED_FLOOR) * completion);
    const mesh = this._makeArrowMesh();
    mesh.position.copy(origin);
    const level = this._skillLevel(weapon.skill);
    const dmgScale = 0.4 + 0.6 * completion;
    let amount = this._computeRawDamage(weapon, { damageMult: 1 }, level) * dmgScale;
    if (attacker === game.player) amount *= playerDamageMult();
    this.arrows.push({ mesh, velocity: dir.multiplyScalar(speed), life: 3, weapon, amount, source: attacker });
    game.scene?.add(mesh);
  }

  _advanceRanged(dt) {
    const game = this.game;
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.velocity.y -= GRAVITY * dt;
      a.mesh.position.addScaledVector(a.velocity, dt);
      a.life -= dt;
      const groundY = game.world?.heightAt?.(a.mesh.position.x, a.mesh.position.z) ?? -Infinity;
      let dead = a.life <= 0 || a.mesh.position.y <= groundY;
      if (!dead) {
        const targets = game.entities?.near(a.mesh.position, 0.6,
          (e) => e !== a.source && (a.source.faction == null || e.faction == null || e.faction !== a.source.faction)) ?? [];
        if (targets.length) {
          const target = targets[0];
          const height = target.height ?? (target.radius ? target.radius * 2 : 1.6);
          const headshot = a.mesh.position.y >= target.position.y + height * 0.75;
          this.applyHit(target, this._buildRangedHit(a, headshot));
          dead = true;
        }
      }
      if (dead) { game.scene?.remove(a.mesh); this.arrows.splice(i, 1); }
    }
  }

  _buildRangedHit(a, headshot) {
    const weapon = a.weapon;
    let amount = a.amount;
    if (headshot) amount *= weapon.ranged.headshot ?? 1;
    const guaranteedCrit = a.source === this.game.player && this.riposteWindow > 0;
    const crit = headshot || guaranteedCrit || rollCrit(this._skillLevel(weapon.skill), false);
    if (crit && !headshot) amount *= CRIT_MULT;
    if (guaranteedCrit) this.riposteWindow = 0;
    return {
      amount, type: dominantDamageType(weapon.damage), stagger: weapon.stagger ?? 0,
      knockback: weapon.knockback ?? 0, source: a.source, crit, skill: weapon.skill,
      armourPierce: weapon.armourPierce ?? 0,
    };
  }

  _advanceRune(dt) {
    const game = this.game;
    for (let i = this.runeBolts.length - 1; i >= 0; i--) {
      const b = this.runeBolts[i];
      b.mesh.position.addScaledVector(b.velocity, dt);
      b.life -= dt;
      let dead = b.life <= 0;
      if (!dead) {
        const targets = game.entities?.near(b.mesh.position, 0.7,
          (e) => e !== b.source && (b.source.faction == null || e.faction == null || e.faction !== b.source.faction)) ?? [];
        if (targets.length) { this.applyHit(targets[0], this._buildRuneHit(b)); dead = true; }
      }
      if (dead) { game.scene?.remove(b.mesh); this.runeBolts.splice(i, 1); }
    }
  }

  _buildRuneHit(b) {
    const effects = this._effects();
    const amount = b.rune.damage * (effects.runeDamageMult ?? 1)
      * (b.source === this.game.player ? playerDamageMult() : 1);
    return { amount, type: b.rune.type, stagger: amount * 0.4, knockback: 1, source: b.source, crit: false, skill: 'seidr' };
  }

  // --------------------------------------------------------------- decay

  _decayEntities(dt) {
    const decay = (e) => {
      if (!e) return;
      if (e.staggered > 0) e.staggered = Math.max(0, e.staggered - dt);
      else if (e.stagger > 0) e.stagger = Math.max(0, e.stagger - STAGGER_DRAIN * dt);
    };
    const list = this.game.entities?.list;
    if (list) for (const e of list) decay(e);
    if (this.game.player && !list?.includes(this.game.player)) decay(this.game.player);
  }

  _decayBleeds(dt) {
    for (const [target, bleed] of this._bleeds) {
      if (target.isDead) { this._bleeds.delete(target); continue; }
      this._dealDamage(target, { amount: bleed.dps * dt, type: 'poison', source: null });
      bleed.remaining -= dt;
      if (bleed.remaining <= 0) this._bleeds.delete(target);
    }
  }

  // ------------------------------------------------------------- visuals

  _makeTrail() {
    const scene = this.game.scene;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SEGMENTS * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xe8e4d8, transparent: true, opacity: 0.9, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    scene?.add(line);
    return { line, mat, geo };
  }

  _updateTrailGeometry(s) {
    const { attacker, move, trail } = s;
    if (!trail) return;
    const [fx, fz] = getForwardXZ(this.game, attacker);
    const baseAngle = Math.atan2(fx, fz);
    const attr = trail.geo.attributes.position;
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const t = i / (TRAIL_SEGMENTS - 1);
      const angle = baseAngle - move.arc / 2 + move.arc * t;
      const x = attacker.position.x + Math.sin(angle) * move.reach;
      const z = attacker.position.z + Math.cos(angle) * move.reach;
      attr.setXYZ(i, x, attacker.position.y + 1.1, z);
    }
    attr.needsUpdate = true;
  }

  _retireTrail(trail) {
    if (!trail) return;
    this.fadingTrails.push({ ...trail, life: TRAIL_FADE_TIME });
  }

  _updateTrails(dt) {
    for (let i = this.fadingTrails.length - 1; i >= 0; i--) {
      const f = this.fadingTrails[i];
      f.life -= dt;
      f.mat.opacity = Math.max(0, f.life / TRAIL_FADE_TIME) * 0.9;
      if (f.life <= 0) {
        this.game.scene?.remove(f.line);
        f.geo.dispose(); f.mat.dispose();
        this.fadingTrails.splice(i, 1);
      }
    }
  }

  _getSparkTexture() {
    if (this._sparkTex) return this._sparkTex;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,230,180,0.8)');
    g.addColorStop(1, 'rgba(255,180,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    this._sparkTex = new THREE.CanvasTexture(c);
    return this._sparkTex;
  }

  _spawnSpark(position, colour = 0xffffff) {
    const scene = this.game.scene;
    if (!scene || !position) return;
    const mat = new THREE.SpriteMaterial({
      map: this._getSparkTexture(), color: colour, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(position);
    sprite.position.y += 0.9;
    sprite.scale.setScalar(0.1);
    scene.add(sprite);
    this.sparks.push({ sprite, mat, life: SPARK_LIFE, maxLife: SPARK_LIFE });
  }

  _updateSparks(dt) {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      const t = 1 - s.life / s.maxLife;
      s.sprite.scale.setScalar(0.1 + t * 0.9);
      s.mat.opacity = Math.max(0, 1 - t);
      if (s.life <= 0) { this.game.scene?.remove(s.sprite); s.mat.dispose(); this.sparks.splice(i, 1); }
    }
  }

  _spawnDamageNumber(position, amount, crit) {
    const scene = this.game.scene;
    if (!scene || !position) return;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = crit ? 'bold 40px sans-serif' : 'bold 30px sans-serif';
    ctx.fillStyle = crit ? '#ffd24a' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(amount).toString(), 64, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(crit ? 1.4 : 1.0, crit ? 0.7 : 0.5, 1);
    sprite.position.copy(position);
    sprite.position.y += 1.6;
    sprite.position.x += (Math.random() - 0.5) * 0.4;
    scene.add(sprite);
    this.damageNumbers.push({ sprite, mat, tex, life: DMG_NUMBER_LIFE, maxLife: DMG_NUMBER_LIFE });
  }

  _updateDamageNumbers(dt) {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      d.sprite.position.y += dt * 0.8;
      d.mat.opacity = Math.max(0, d.life / d.maxLife);
      if (d.life <= 0) {
        this.game.scene?.remove(d.sprite);
        d.mat.dispose(); d.tex.dispose();
        this.damageNumbers.splice(i, 1);
      }
    }
  }

  _updateShake(dt) {
    if (this.shakeTrauma <= 0) return;
    const cam = this.game.camera;
    if (cam) {
      const t = this.shakeTrauma * this.shakeTrauma;
      this._shakeOffset.set((Math.random() * 2 - 1) * t * SHAKE_POS, (Math.random() * 2 - 1) * t * SHAKE_POS, 0);
      cam.position.add(this._shakeOffset);
      cam.rotation.z += (Math.random() * 2 - 1) * t * SHAKE_ROT;
    }
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * SHAKE_DECAY);
  }

  _makeArrowMesh() {
    if (!this._arrowGeo) this._arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.6, 5);
    if (!this._arrowMat) this._arrowMat = new THREE.MeshBasicMaterial({ color: 0x9a7c4a });
    const mesh = new THREE.Mesh(this._arrowGeo, this._arrowMat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  _makeRuneBolt(type) {
    if (!this._runeGeo) this._runeGeo = new THREE.SphereGeometry(0.18, 8, 8);
    if (!this._runeMats) this._runeMats = {};
    if (!this._runeMats[type]) {
      const colour = type === 'fire' ? 0xff5a2a : type === 'frost' ? 0x7fd0ec : 0xd8c8f0;
      this._runeMats[type] = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.9 });
    }
    return new THREE.Mesh(this._runeGeo, this._runeMats[type]);
  }
}

export function createCombat(game) {
  return new Combat(game);
}
