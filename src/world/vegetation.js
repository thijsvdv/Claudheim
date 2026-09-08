import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { lerp } from '../core/math.js';
import { BIOMES } from '../data/biomes.js';
import { CHUNK_SIZE } from './terrain.js';

/**
 * Instanced grass tufts. One InstancedMesh per chunk, one shared geometry and
 * one shared material for the whole world; the wind is a vertex-shader patch so
 * nothing has to be touched per frame except a single uniform.
 */

const TUFT_HEIGHT = 0.55;
const TUFT_WIDTH = 0.13;
const BLADES = 3;
const MAX_SLOPE = 0.55;
const GRASS_CHUNK_RADIUS = 4;   // chunks; grass is the first thing to cut
const ATTEMPTS = 300;

function buildTuft() {
  const pos = [], nrm = [], col = [];
  const base = new THREE.Color(0x2f4420);
  const tip = new THREE.Color(0xcfd68a);
  const push = (x, y, z, nx, nz, c) => {
    pos.push(x, y, z); nrm.push(nx, 1.0, nz); col.push(c.r, c.g, c.b);
  };
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI + 0.4;
    const dx = Math.cos(a) * TUFT_WIDTH, dz = Math.sin(a) * TUFT_WIDTH;
    const h = TUFT_HEIGHT * (0.7 + 0.3 * ((b * 7) % 3) / 2);
    const nx = -Math.sin(a) * 0.35, nz = Math.cos(a) * 0.35;
    // Two triangles per blade, tapering to a point.
    push(-dx, 0, -dz, nx, nz, base);
    push(dx, 0, dz, nx, nz, base);
    push(dx * 0.35, h, dz * 0.35, nx, nz, tip);

    push(-dx, 0, -dz, nx, nz, base);
    push(dx * 0.35, h, dz * 0.35, nx, nz, tip);
    push(-dx * 0.35, h * 0.92, -dz * 0.35, nx, nz, tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.normalizeNormals();
  g.computeBoundingSphere();
  return g;
}

function hash32(a, b, seed) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  return (h ^ (h >>> 15)) >>> 0;
}

export function createVegetation(game, terrain) {
  const group = new THREE.Group();
  group.name = 'vegetation';

  const geometry = buildTuft();
  const uTime = { value: 0 };
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      '#ifdef USE_INSTANCING',
      '  vec2 wpos = vec2(instanceMatrix[3].x, instanceMatrix[3].z);',
      '#else',
      '  vec2 wpos = vec2(0.0);',
      '#endif',
      '  float sway = max(transformed.y, 0.0) * 0.42;',
      '  transformed.x += sin(uTime * 1.7 + wpos.x * 0.31 + wpos.y * 0.19) * sway;',
      '  transformed.z += cos(uTime * 1.15 + wpos.y * 0.27) * sway * 0.55;',
    ].join('\n'));
  };
  // Two materials that compile differently must not share a program cache key.
  material.customProgramCacheKey = () => 'ashwake-grass';

  const byChunk = new Map();
  const probe = {};
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  const tint = {};
  for (const id in BIOMES) if (BIOMES[id].grass != null) tint[id] = new THREE.Color(BIOMES[id].grass);

  function populate(key, cx, cz) {
    if (byChunk.has(key)) return;
    const rng = mulberry32(hash32(cx, cz, terrain.seed ^ 0x5bf03635));
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const items = [];

    for (let a = 0; a < ATTEMPTS; a++) {
      const x = x0 + rng() * CHUNK_SIZE;
      const z = z0 + rng() * CHUNK_SIZE;
      const spin = rng() * Math.PI * 2;
      const sc = 0.7 + rng() * 0.9;
      const shade = 0.78 + rng() * 0.42;

      terrain.probe(x, z, probe);
      if (probe.y < 0.25 || probe.slope > MAX_SLOPE) continue;
      const g = tint[probe.biome];
      if (!g) continue;
      items.push({ x, y: probe.y, z, spin, sc, shade, biome: probe.biome });
    }
    if (!items.length) { byChunk.set(key, null); return; }

    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      _e.set(0, it.spin, 0);
      _q.setFromEuler(_e);
      _v.set(it.x, it.y - 0.05, it.z);
      _s.set(it.sc, it.sc * lerp(0.8, 1.4, it.shade - 0.78), it.sc);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
      _c.copy(tint[it.biome]).multiplyScalar(it.shade);
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    byChunk.set(key, mesh);
  }

  function unload(key) {
    const mesh = byChunk.get(key);
    if (mesh) { group.remove(mesh); mesh.dispose(); }
    byChunk.delete(key);
  }

  return {
    group, material, geometry, byChunk,
    chunkRadius: GRASS_CHUNK_RADIUS,
    populate, unload,
    update(dt) { uTime.value += dt; },
    dispose() {
      for (const key of [...byChunk.keys()]) unload(key);
      geometry.dispose();
      material.dispose();
    },
  };
}
