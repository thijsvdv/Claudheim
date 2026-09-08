import * as THREE from 'three';
import { CHUNK_SIZE } from './terrain.js';

/**
 * Chunk lifecycle. Chunks inside LOAD_RADIUS are queued nearest-first and built
 * a few at a time under a millisecond budget, so walking never stutters. They
 * are only released past UNLOAD_RADIUS — the gap is hysteresis, otherwise
 * pacing back and forth across a border thrashes the builder.
 */

export const LOAD_RADIUS = 6;
export const UNLOAD_RADIUS = 8;

const FRAME_BUDGET_MS = 5;
const MAX_PER_FRAME = 3;

const keyOf = (cx, cz) => `${cx},${cz}`;

export function createChunkManager(game, terrain, { resources, vegetation } = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';

  const loaded = new Map();     // key -> { key, cx, cz, mesh, hasGrass }
  const pending = new Map();    // key -> { key, cx, cz, d2 }
  let queue = [];
  let lastCx = null, lastCz = null;
  let dirty = true;

  const load2 = LOAD_RADIUS * LOAD_RADIUS;
  const unload2 = UNLOAD_RADIUS * UNLOAD_RADIUS;
  const grass2 = (vegetation?.chunkRadius ?? 4) ** 2;

  function build(cx, cz) {
    const key = keyOf(cx, cz);
    if (loaded.has(key)) return loaded.get(key);
    const geo = terrain.buildChunkGeometry(cx, cz);
    const mesh = new THREE.Mesh(geo, terrain.material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.chunkKey = key;
    group.add(mesh);

    const entry = { key, cx, cz, mesh, hasGrass: false };
    loaded.set(key, entry);
    resources?.populate(key, cx, cz);
    return entry;
  }

  function release(entry) {
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    resources?.unload(entry.key);
    vegetation?.unload(entry.key);
    loaded.delete(entry.key);
  }

  function rescan(pcx, pcz) {
    pending.clear();
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > load2) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = keyOf(cx, cz);
        if (loaded.has(key)) continue;
        pending.set(key, { key, cx, cz, d2 });
      }
    }
    queue = [...pending.values()].sort((a, b) => a.d2 - b.d2);

    for (const entry of [...loaded.values()]) {
      const dx = entry.cx - pcx, dz = entry.cz - pcz;
      if (dx * dx + dz * dz > unload2) release(entry);
    }
  }

  /** Grass follows the player separately — it has a much tighter radius. */
  function tendGrass(pcx, pcz) {
    if (!vegetation) return;
    for (const entry of loaded.values()) {
      const dx = entry.cx - pcx, dz = entry.cz - pcz;
      const inside = dx * dx + dz * dz <= grass2;
      if (inside && !entry.hasGrass) {
        vegetation.populate(entry.key, entry.cx, entry.cz);
        entry.hasGrass = true;
      } else if (!inside && entry.hasGrass && dx * dx + dz * dz > grass2 + 6) {
        vegetation.unload(entry.key);
        entry.hasGrass = false;
      }
    }
  }

  function pump() {
    const t0 = performance.now();
    let made = 0;
    while (queue.length && made < MAX_PER_FRAME) {
      const job = queue.shift();
      pending.delete(job.key);
      build(job.cx, job.cz);
      made++;
      if (performance.now() - t0 > FRAME_BUDGET_MS) break;
    }
    return made;
  }

  return {
    group,
    loaded,
    get queued() { return queue.length; },

    /** Build everything within `radius` chunks right now. Boot / teleport only. */
    forceLoad(x, z, radius = 2) {
      const pcx = Math.floor(x / CHUNK_SIZE), pcz = Math.floor(z / CHUNK_SIZE);
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > radius * radius) continue;
          build(pcx + dx, pcz + dz);
        }
      }
      lastCx = null;
      dirty = true;
    },

    isLoaded(x, z) {
      return loaded.has(keyOf(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
    },

    chunkKeyAt(x, z) {
      return keyOf(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    },

    update(dt, focus) {
      const pcx = Math.floor(focus.x / CHUNK_SIZE);
      const pcz = Math.floor(focus.z / CHUNK_SIZE);
      if (dirty || pcx !== lastCx || pcz !== lastCz) {
        lastCx = pcx; lastCz = pcz; dirty = false;
        rescan(pcx, pcz);
        tendGrass(pcx, pcz);
      }
      if (pump() > 0) tendGrass(pcx, pcz);
    },

    dispose() {
      for (const entry of [...loaded.values()]) release(entry);
      queue.length = 0;
      pending.clear();
    },
  };
}
