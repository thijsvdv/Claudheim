import * as THREE from 'three';
import { createTerrain, CHUNK_SIZE, SEA_LEVEL, SHORE_BAND, SNOW_LINE } from './terrain.js';
import { createChunkManager, LOAD_RADIUS, UNLOAD_RADIUS } from './chunks.js';
import { createResources } from './resources.js';
import { createVegetation } from './vegetation.js';
import { createWater } from './water.js';

export { CHUNK_SIZE, SEA_LEVEL, SHORE_BAND, SNOW_LINE, LOAD_RADIUS, UNLOAD_RADIUS };

/**
 * The world system. Terrain is a pure function of (x, z) derived from
 * game.seed, so every query below works before a single chunk has been built —
 * the player can be spawned and the AI can path in the frame the game boots.
 */
export function createWorld(game) {
  const terrain = createTerrain(game.seed);
  const resources = createResources(game, terrain);
  const vegetation = createVegetation(game, terrain);
  const water = createWater(game);
  const chunks = createChunkManager(game, terrain, { resources, vegetation });

  const root = new THREE.Group();
  root.name = 'world';
  root.add(chunks.group, resources.group, vegetation.group, water.mesh);

  const focus = new THREE.Vector3();
  const discovered = new Set();
  let lastBiome = null;
  let biomeTimer = 0;

  function focusPosition(out) {
    const p = game.player?.position
      || game.player?.object?.position
      || game.player?.entity?.position
      || game.player?.mesh?.position;
    if (p) return out.copy(p);
    return out.copy(game.camera.position);
  }

  const world = {
    name: 'world',

    // --- sub-modules, exposed for the systems that legitimately need them ---
    terrain, chunks, vegetation, water, root,
    resources,

    // --- hard interface (ARCHITECTURE.md) ---
    heightAt: terrain.heightAt,
    normalAt: terrain.normalAt,
    biomeAt: terrain.biomeAt,
    isWater: terrain.isWater,
    sampleGround: terrain.sampleGround,

    // --- conveniences ---
    /** Allocation-free probe: fills `out` with y/nx/ny/nz/slope/biome. */
    probe: terrain.probe,
    seaLevel: SEA_LEVEL,
    chunkSize: CHUNK_SIZE,

    /** Depth of water at (x, z); 0 on dry land. */
    waterDepth(x, z) {
      const y = terrain.heightAt(x, z);
      return y < SEA_LEVEL ? SEA_LEVEL - y : 0;
    },

    /** Drop a point onto the ground, keeping it above water if asked. */
    snapToGround(v, offset = 0) {
      v.y = terrain.heightAt(v.x, v.z) + offset;
      return v;
    },

    /**
     * Somewhere to wake up: gentle ground in the meadow ring, clear of the
     * Ashwake at the island's heart.
     */
    findSpawn(preferredBiome = 'fjaldmark') {
      const out = new THREE.Vector3();
      const fallback = new THREE.Vector3();
      let haveFallback = false;
      for (let r = 110; r <= 280; r += 15) {
        for (let i = 0; i < 64; i++) {
          const a = (i / 64) * Math.PI * 2 + r * 0.137;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const y = terrain.heightAt(x, z);
          if (y < 1 || y > 26) continue;
          const b = terrain.biomeAt(x, z);
          if (b === 'ashwake' || b === 'ocean') continue;
          if (terrain.sampleGround(x, z).slope > 0.45) continue;
          if (b === preferredBiome) return out.set(x, y, z);
          if (!haveFallback) { fallback.set(x, y, z); haveFallback = true; }
        }
      }
      if (haveFallback) return out.copy(fallback);
      return out.set(0, terrain.heightAt(0, 0), 0);
    },

    /** Force the chunks around a point to exist right now (boot, teleport). */
    ensureAround(x, z, radius = 2) { chunks.forceLoad(x, z, radius); },

    init(g) {
      g.scene.add(root);
      focusPosition(focus);
      chunks.forceLoad(focus.x, focus.z, 2);
      g.debug('world ready', {
        seed: terrain.seed, chunks: chunks.loaded.size, nodes: resources.count(),
      });
    },

    update(dt, g) {
      focusPosition(focus);
      chunks.update(dt, focus);
      resources.update?.(dt);
      vegetation.update(dt);
      water.update(dt);

      biomeTimer -= dt;
      if (biomeTimer <= 0) {
        biomeTimer = 0.4;
        const b = terrain.biomeAt(focus.x, focus.z);
        if (b !== lastBiome) {
          lastBiome = b;
          if (!discovered.has(b)) {
            discovered.add(b);
            g.bus.emit('biome:discovered', { biome: b, position: focus.clone() });
          }
        }
      }
    },

    /** Biome the player is standing in, refreshed a few times a second. */
    get currentBiome() { return lastBiome || 'fjaldmark'; },
    get discovered() { return discovered; },

    serialize() {
      return {
        seed: terrain.seed,
        discovered: [...discovered],
        resources: resources.serialize(),
      };
    },

    hydrate(data) {
      if (!data) return;
      if (Array.isArray(data.discovered)) for (const b of data.discovered) discovered.add(b);
      resources.hydrate?.(data.resources);
    },

    dispose() {
      game.scene.remove(root);
      chunks.dispose();
      resources.dispose();
      vegetation.dispose();
      water.dispose();
      terrain.dispose();
    },
  };

  return world;
}
