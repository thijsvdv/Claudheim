import * as THREE from 'three';
import { fbm, ridged, noise2 } from './noise.js';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { BIOMES } from '../data/biomes.js';

// --- chunk geometry constants (see ARCHITECTURE.md "Conventions") ---
export const CHUNK_SIZE = 32;
export const VERT_SPACING = 2;
export const CHUNK_SEGS = CHUNK_SIZE / VERT_SPACING; // 16 quads
export const CHUNK_VERTS = CHUNK_SEGS + 1;           // 17x17 vertices

export const SEA_LEVEL = 0;
export const SHORE_BAND = 1.5;   // |y| below this reads as beach
export const SNOW_LINE = 54;
export const MOUNTAIN_ELEVATION = 45;

const OCEAN_FLOOR = -24;
const SHORE_R = 520;             // nominal coastline radius in metres

// Ring biomes compete by score; ocean/shore are decided by elevation instead.
const RING_BIOMES = ['ashwake', 'fjaldmark', 'myrkvid', 'mire', 'frostreach'];
const RING_BIAS = { ashwake: 2.2, fjaldmark: 1, myrkvid: 1, mire: 1, frostreach: 1 };
const RING_WOBBLE = { ashwake: 0.12, fjaldmark: 0.3, myrkvid: 0.3, mire: 0.3, frostreach: 0.3 };
const RING_BLEND = 55;
const FJALDMARK_FLOOR = 0.2;     // meadow is the fallback when no ring claims a spot

const ROCK_COLOUR = new THREE.Color(0x6d675f);
const SNOW_COLOUR = new THREE.Color(0xeaf1f6);
const DEEP_TINT = new THREE.Color(0x1c2a30);

/** One shared index buffer for every chunk — the topology never varies. */
let sharedIndex = null;
function chunkIndex() {
  if (!sharedIndex) {
    // Borrow PlaneGeometry's winding so we cannot get the triangle order wrong.
    // Its vertex (ix, iy) lands at x = ix*2 - 16, z = iy*2 - 16 after the
    // rotate, i.e. exactly our row-major (i, j) layout.
    const tmpl = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SEGS, CHUNK_SEGS);
    tmpl.rotateX(-Math.PI / 2);
    sharedIndex = tmpl.index;
  }
  return sharedIndex;
}

function ringScore(r, band, blend) {
  const a = band[0], b = band[1];
  const inner = a <= 0 ? 1 : smoothstep(a - blend, a + blend, r);
  const outer = (b === Infinity || b == null) ? 1 : smoothstep(b + blend, b - blend, r);
  return inner < outer ? inner : outer;
}

/**
 * The island field. Every public query funnels through `field()` so the
 * heightmap is one pure function of (x, z) — that is what keeps chunk borders
 * C0 continuous without any stitching.
 */
export function createTerrain(seed) {
  const S = seed | 0;

  const ground = {}, sand = {};
  for (const id in BIOMES) {
    ground[id] = new THREE.Color(BIOMES[id].ground);
    sand[id] = new THREE.Color(BIOMES[id].sand);
  }

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });

  /**
   * Two warped radii. The coastline gets a violent warp so the island grows
   * headlands and inlets; the biome bands get a gentler one so their borders
   * wander without shredding the difficulty ring.
   */
  function coastRadius(x, z) {
    return Math.hypot(x, z)
      + fbm(x * 0.0014, z * 0.0014, S + 101, 4) * 430
      + fbm(x * 0.0046, z * 0.0046, S + 137, 3) * 135;
  }

  function ringRadius(x, z) {
    const d = Math.hypot(x, z);
    // Fade the warp in with distance, or the tiny Ashwake ring at the centre
    // would wander further than its own radius.
    return d + fbm(x * 0.0018, z * 0.0018, S + 149, 3) * 265 * smoothstep(0, 260, d);
  }

  const landMask = (r) => smoothstep(SHORE_R + 95, SHORE_R - 165, r);

  /** Where the swamp basins sit. Purely positional so height can depend on it. */
  function mireMask(x, z, r) {
    const band = smoothstep(228, 298, r) * smoothstep(478, 396, r);
    if (band <= 0) return 0;
    const n = fbm(x * 0.0026, z * 0.0026, S + 77, 3);
    return band * smoothstep(-0.09, 0.11, n);
  }

  function mountainMask(x, z, r, land) {
    const band = smoothstep(298, 398, r) * smoothstep(604, 474, r);
    if (band <= 0) return 0;
    const n = fbm(x * 0.0026, z * 0.0026, S + 53, 3);
    return band * smoothstep(-0.26, 0.2, n) * smoothstep(0.5, 0.85, land);
  }

  /**
   * Fills `f` with { x, z, r, land, mire, y }. Deliberately allocation free —
   * chunk builds call this hundreds of times per chunk.
   */
  function field(x, z, f) {
    const r = ringRadius(x, z);
    const t = landMask(coastRadius(x, z));
    f.x = x; f.z = z; f.r = r; f.land = t;

    const wx = x + fbm(x * 0.0035, z * 0.0035, S + 211, 3) * 40;
    const wz = z + fbm(x * 0.0035 + 7.7, z * 0.0035 - 3.1, S + 223, 3) * 40;

    const continent = fbm(wx * 0.0022, wz * 0.0022, S + 7, 5);
    const hills = fbm(wx * 0.0075, wz * 0.0075, S + 13, 4);
    const detail = fbm(x * 0.028, z * 0.028, S + 29, 3);

    // Three overlapping ramps: ocean shelf, a deliberately shallow beach, then
    // inland relief. Keeping them as ramps on `t` makes the coast continuous.
    let y = OCEAN_FLOOR;
    y += 22 * smoothstep(0, 0.26, t);
    y += 5 * smoothstep(0.26, 0.44, t);
    y += (11 + continent * 13 + hills * 6.5) * smoothstep(0.34, 0.95, t);
    y += detail * 1.5 * t;
    y += (1 - t) * fbm(x * 0.012, z * 0.012, S + 61, 2) * 2.5;

    const m = mountainMask(wx, wz, r, t);
    if (m > 0) {
      const rg = ridged(wx * 0.0042, wz * 0.0042, S + 31, 5);
      y += smoothstep(0.22, 0.9, rg) * 76 * m;
    }

    // Basins never eat a mountain: the swamp yields to the ridges above it.
    const mire = mireMask(x, z, r) * (1 - m * 0.9);
    if (mire > 0) {
      const basin = -0.7 + fbm(x * 0.04, z * 0.04, S + 83, 2) * 1.7;
      y = lerp(y, basin, mire * 0.85);
    }

    f.mire = mire;
    f.y = y;
    return f;
  }

  /**
   * Ring competition. Writes `biome`, `biome2` and `mix` (0..0.5 blend weight
   * toward the runner-up, used only for vertex colour).
   */
  function classify(f, y) {
    const { x, z, r } = f;
    let bestId = 'fjaldmark', best = -Infinity;
    let nextId = 'fjaldmark', next = -Infinity;

    for (let i = 0; i < RING_BIOMES.length; i++) {
      const id = RING_BIOMES[i];
      let w = ringScore(r, BIOMES[id].ring, RING_BLEND) * RING_BIAS[id];
      if (id === 'fjaldmark' && w < FJALDMARK_FLOOR) w = FJALDMARK_FLOOR;
      if (id === 'mire') w *= 0.15 + 1.05 * f.mire;
      // The mountains are the only biome that also gates on elevation.
      if (id === 'frostreach') w *= smoothstep(MOUNTAIN_ELEVATION - 20, MOUNTAIN_ELEVATION + 2, y);
      if (w <= 0) continue;
      w += noise2(x * 0.0045, z * 0.0045, S + 300 + i * 131) * RING_WOBBLE[id];
      if (w > best) { next = best; nextId = bestId; best = w; bestId = id; }
      else if (w > next) { next = w; nextId = id; }
    }

    f.biome = bestId;
    f.biome2 = nextId;
    f.mix = next === -Infinity ? 0 : 0.5 * smoothstep(0.22, 0, best - next);
    return bestId;
  }

  /** Surface biome id, including the water/beach overrides. */
  function surfaceBiome(f, y) {
    classify(f, y);
    if (f.mire > 0.3) return 'mire';
    if (y < -SHORE_BAND) return 'ocean';
    if (y < SHORE_BAND) return 'shore';
    return f.biome;
  }

  const _h = {};
  function heightAt(x, z) { return field(x, z, _h).y; }

  const _b = {};
  function biomeAt(x, z) {
    field(x, z, _b);
    return surfaceBiome(_b, _b.y);
  }

  function isWater(x, z) { return heightAt(x, z) < SEA_LEVEL; }

  const _n = {};
  const EPS = 1.0;
  function normalAt(x, z, target) {
    const out = target || new THREE.Vector3();
    const hl = field(x - EPS, z, _n).y;
    const hr = field(x + EPS, z, _n).y;
    const hd = field(x, z - EPS, _n).y;
    const hu = field(x, z + EPS, _n).y;
    return out.set(hl - hr, 2 * EPS, hd - hu).normalize();
  }

  const _p = {};
  const _pn = new THREE.Vector3();
  /**
   * Allocation-free ground probe. `out` gains { y, nx, ny, nz, slope, biome,
   * biome2, mix, land, mire, r }. `slope` is radians away from vertical.
   */
  function probe(x, z, out) {
    const o = out || {};
    field(x, z, _p);
    const y = _p.y;
    normalAt(x, z, _pn);
    o.y = y;
    o.nx = _pn.x; o.ny = _pn.y; o.nz = _pn.z;
    o.slope = Math.acos(clamp(_pn.y, -1, 1));
    o.r = _p.r; o.land = _p.land; o.mire = _p.mire;
    o.biome = surfaceBiome(_p, y);
    o.ground = _p.biome; o.ground2 = _p.biome2; o.mix = _p.mix;
    return o;
  }

  const _sg = {};
  function sampleGround(x, z) {
    probe(x, z, _sg);
    return {
      y: _sg.y,
      normal: new THREE.Vector3(_sg.nx, _sg.ny, _sg.nz),
      biome: _sg.biome,
      slope: _sg.slope,
    };
  }

  const _c = new THREE.Color();
  /**
   * Vertex tint: blended biome ground, sand at the waterline, exposed rock on
   * steep faces, snow above the snowline.
   */
  function vertexColour(x, z, y, ny, f, target) {
    const a = f.biome, b = f.biome2, mix = f.mix;
    target.copy(ground[a] || ground.fjaldmark);
    if (mix > 0.001) target.lerp(ground[b] || ground.fjaldmark, mix);

    const beach = smoothstep(2.8, 0.3, y);
    if (beach > 0) {
      _c.copy(sand[a] || sand.shore);
      if (mix > 0.001) _c.lerp(sand[b] || sand.shore, mix);
      target.lerp(_c, beach * 0.92);
    }

    const rock = smoothstep(0.87, 0.63, ny);
    if (rock > 0) target.lerp(ROCK_COLOUR, rock * 0.85);

    const snow = smoothstep(SNOW_LINE - 10, SNOW_LINE + 12, y) * (1 - rock * 0.55);
    if (snow > 0) target.lerp(SNOW_COLOUR, snow);

    if (y < -1) target.lerp(DEEP_TINT, smoothstep(-1, -14, y) * 0.55);

    // Break up the flat wash without another octave of terrain noise.
    const v = 0.94 + noise2(x * 0.09, z * 0.09, S + 909) * 0.07;
    target.multiplyScalar(v);
    return target;
  }

  // Scratch buffers reused by every chunk build.
  const P = CHUNK_VERTS + 2;
  const padded = new Float32Array(P * P);
  const _cf = {};
  const _cc = new THREE.Color();

  function buildChunkGeometry(cx, cz) {
    const N = CHUNK_VERTS;
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;

    // One extra ring of samples so edge normals match the neighbouring chunk.
    for (let j = 0; j < P; j++) {
      const wz = z0 + (j - 1) * VERT_SPACING;
      for (let i = 0; i < P; i++) {
        padded[j * P + i] = field(x0 + (i - 1) * VERT_SPACING, wz, _cf).y;
      }
    }

    const pos = new Float32Array(N * N * 3);
    const nrm = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const inv = 1 / (2 * VERT_SPACING);
    let lo = Infinity, hi = -Infinity;

    for (let j = 0; j < N; j++) {
      const wz = z0 + j * VERT_SPACING;
      for (let i = 0; i < N; i++) {
        const wx = x0 + i * VERT_SPACING;
        const pi = (j + 1) * P + (i + 1);
        const y = padded[pi];
        if (y < lo) lo = y;
        if (y > hi) hi = y;

        const dx = (padded[pi + 1] - padded[pi - 1]) * inv;
        const dz = (padded[pi + P] - padded[pi - P]) * inv;
        let nx = -dx, ny = 1, nz = -dz;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;

        const k = (j * N + i) * 3;
        pos[k] = i * VERT_SPACING; pos[k + 1] = y; pos[k + 2] = j * VERT_SPACING;
        nrm[k] = nx; nrm[k + 1] = ny; nrm[k + 2] = nz;

        field(wx, wz, _cf);
        classify(_cf, y);
        vertexColour(wx, wz, y, ny, _cf, _cc);
        col[k] = _cc.r; col[k + 1] = _cc.g; col[k + 2] = _cc.b;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(chunkIndex());
    const half = CHUNK_SIZE * 0.5;
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, lo, 0), new THREE.Vector3(CHUNK_SIZE, hi, CHUNK_SIZE));
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(half, (lo + hi) * 0.5, half),
      Math.hypot(half, (hi - lo) * 0.5, half));
    return geo;
  }

  return {
    seed: S,
    material,
    heightAt, normalAt, biomeAt, isWater, sampleGround,
    probe, field, classify, surfaceBiome, ringRadius, mireMask,
    buildChunkGeometry,
    groundColour: (id) => ground[id] || ground.fjaldmark,
    dispose() { material.dispose(); },
  };
}
