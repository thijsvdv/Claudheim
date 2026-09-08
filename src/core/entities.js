import * as THREE from 'three';

let nextId = 1;
export const newEntityId = () => nextId++;

/**
 * Flat registry of everything that can be hit. Kept in a plain array with a
 * cheap spatial pre-filter — entity counts stay in the low hundreds, so a
 * hashed grid would cost more than it saves.
 */
export class EntityRegistry {
  constructor() { this.list = []; this.byId = new Map(); }

  add(e) {
    if (e.id == null) e.id = newEntityId();
    if (this.byId.has(e.id)) return e;
    this.list.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  remove(e) {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    this.byId.delete(e.id);
  }

  near(pos, radius, filter) {
    const r2 = radius * radius;
    const out = [];
    for (const e of this.list) {
      if (e.isDead) continue;
      if (filter && !filter(e)) continue;
      const dx = e.position.x - pos.x;
      const dy = e.position.y - pos.y;
      const dz = e.position.z - pos.z;
      const pad = (e.radius || 0);
      if (dx * dx + dy * dy + dz * dz <= r2 + pad * pad + 2 * radius * pad) out.push(e);
    }
    return out;
  }

  /** Nearest entity matching filter, or null. */
  nearest(pos, radius, filter) {
    let best = null, bestD = Infinity;
    for (const e of this.near(pos, radius, filter)) {
      const d = e.position.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  forEach(fn) { for (let i = this.list.length - 1; i >= 0; i--) fn(this.list[i], i); }
}

/** Mixin giving an object the damageable contract from ARCHITECTURE.md. */
export function makeDamageable(target, { hp, faction, radius = 0.5, maxStagger = 0 }) {
  target.id = newEntityId();
  target.faction = faction;
  target.position = target.position || new THREE.Vector3();
  target.radius = radius;
  target.hp = hp;
  target.maxHp = hp;
  target.stagger = 0;
  target.maxStagger = maxStagger || hp * 0.6;
  target.staggered = 0;
  target.isDead = false;
  return target;
}
