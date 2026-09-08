import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { lerp } from '../core/math.js';
import { WEAPONS } from '../data/weapons.js';
import { CHUNK_SIZE, SHORE_BAND } from './terrain.js';

/**
 * Harvestable world props. Every node is derived from a mulberry32 stream
 * seeded by (chunk x, chunk z, world seed), so unloading and reloading a chunk
 * reproduces exactly the same nodes — only the harvested set is stateful.
 */

const RESPAWN_SECONDS = 15 * 60; // one in-game day

export const NODE_KINDS = {
  birch: {
    tool: 'chop', tier: 0, hp: 60, radius: 0.65, skill: 'axes',
    scale: [0.85, 1.35], drops: [{ item: 'wood', min: 10, max: 10 }],
  },
  pine: {
    tool: 'chop', tier: 1, hp: 110, radius: 0.75, skill: 'axes',
    scale: [0.9, 1.5],
    drops: [{ item: 'corewood', min: 10, max: 10 }, { item: 'resin', min: 0, max: 2 }],
  },
  deadtree: {
    tool: 'chop', tier: 0, hp: 70, radius: 0.6, skill: 'axes',
    scale: [0.8, 1.25], drops: [{ item: 'wood', min: 10, max: 10 }],
  },
  boulder: {
    tool: 'mine', tier: 0, hp: 90, radius: 1.1, skill: 'pickaxes',
    scale: [0.7, 1.6], drops: [{ item: 'stone', min: 4, max: 8 }],
  },
  copper_vein: {
    tool: 'mine', tier: 1, hp: 160, radius: 1.2, skill: 'pickaxes',
    scale: [0.9, 1.4],
    drops: [{ item: 'copper_ore', min: 3, max: 6 }, { item: 'stone', min: 1, max: 3 }],
  },
  tin_vein: {
    tool: 'mine', tier: 1, hp: 130, radius: 0.9, skill: 'pickaxes',
    scale: [0.8, 1.2],
    drops: [{ item: 'tin_ore', min: 2, max: 4 }, { item: 'stone', min: 1, max: 2 }],
  },
  bush: {
    tool: 'pick', tier: 0, hp: 1, radius: 0.5, skill: null,
    scale: [0.85, 1.2], drops: [{ item: 'raspberries', min: 2, max: 4 }],
  },
  nest: {
    tool: 'pick', tier: 0, hp: 1, radius: 0.45, skill: null,
    scale: [0.85, 1.2], drops: [{ item: 'feather', min: 2, max: 4 }],
  },
  branch: {
    tool: 'pick', tier: 0, hp: 1, radius: 0.4, skill: null,
    scale: [0.85, 1.3], drops: [{ item: 'wood', min: 2, max: 3 }],
  },
  stone_pile: {
    tool: 'pick', tier: 0, hp: 1, radius: 0.4, skill: null,
    scale: [0.8, 1.3], drops: [{ item: 'stone', min: 2, max: 4 }],
  },
  flint: {
    tool: 'pick', tier: 0, hp: 1, radius: 0.3, skill: null,
    scale: [0.75, 1.25], drops: [{ item: 'flint', min: 1, max: 2 }],
  },
};

/** Per-biome scatter table: weight is the chance an attempt becomes this kind. */
const SCATTER = {
  fjaldmark: [['birch', 0.36], ['branch', 0.14], ['stone_pile', 0.12], ['bush', 0.16], ['boulder', 0.12], ['nest', 0.05], ['copper_vein', 0.015]],
  myrkvid: [['pine', 0.48], ['branch', 0.08], ['stone_pile', 0.06], ['birch', 0.06], ['boulder', 0.08], ['nest', 0.03], ['copper_vein', 0.05], ['tin_vein', 0.04], ['bush', 0.04]],
  mire: [['deadtree', 0.36], ['branch', 0.08], ['stone_pile', 0.04], ['boulder', 0.06], ['bush', 0.03]],
  frostreach: [['boulder', 0.28], ['stone_pile', 0.1], ['branch', 0.04], ['pine', 0.09], ['tin_vein', 0.07], ['copper_vein', 0.02]],
  shore: [['flint', 0.3], ['stone_pile', 0.12], ['nest', 0.12], ['branch', 0.08], ['boulder', 0.05], ['bush', 0.04]],
  ashwake: [['boulder', 0.22], ['stone_pile', 0.06], ['deadtree', 0.1]],
  ocean: [],
};

const ATTEMPTS = 30;
const MAX_SLOPE = 0.62; // radians; nothing roots on a cliff

// --- geometry -------------------------------------------------------------

/** Bakes a list of {geo, matrix, colour} parts into one vertex-coloured mesh. */
function bake(parts) {
  const pos = [], nrm = [], col = [];
  const c = new THREE.Color();
  for (const part of parts) {
    const g = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    g.applyMatrix4(part.matrix);
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    c.set(part.colour);
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nrm.push(n[i], n[i + 1], n[i + 2]);
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const M = () => new THREE.Matrix4();
const at = (x, y, z, sx, sy, sz, ry) => {
  const m = M();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, 0)),
    new THREE.Vector3(sx, sy ?? sx, sz ?? sx));
  return m;
};

const atE = (x, y, z, sx, sy, sz, rx, ry, rz) => {
  const m = M();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
    new THREE.Vector3(sx, sy ?? sx, sz ?? sx));
  return m;
};

function buildPropGeometries() {
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 1, 6, 1);
  const cone = new THREE.ConeGeometry(1, 1, 7, 1);
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const rock = new THREE.IcosahedronGeometry(1, 0);
  const chip = new THREE.TetrahedronGeometry(1, 0);
  const geo = {};

  geo.birch = bake([
    { geo: trunk, matrix: at(0, 2.4, 0, 1, 4.8, 1), colour: 0xd6d0c0 },
    { geo: blob, matrix: at(0, 5.3, 0, 1.9, 1.5, 1.9), colour: 0x86a84e },
    { geo: blob, matrix: at(0.7, 4.3, -0.4, 1.3, 1.0, 1.3, 0.7), colour: 0x789a44 },
    { geo: blob, matrix: at(-0.6, 6.2, 0.3, 1.2, 0.95, 1.2, 1.9), colour: 0x93b357 },
  ]);

  geo.pine = bake([
    { geo: trunk, matrix: at(0, 3.2, 0, 1.15, 6.4, 1.15), colour: 0x4a3826 },
    { geo: cone, matrix: at(0, 4.0, 0, 2.3, 3.2, 2.3), colour: 0x2c4630 },
    { geo: cone, matrix: at(0, 5.6, 0, 1.8, 3.0, 1.8, 0.6), colour: 0x33523a },
    { geo: cone, matrix: at(0, 7.1, 0, 1.2, 2.6, 1.2, 1.2), colour: 0x3a5c41 },
  ]);

  geo.deadtree = bake([
    { geo: trunk, matrix: at(0, 2.1, 0, 0.85, 4.2, 0.85), colour: 0x54483a },
    { geo: trunk, matrix: at(0.55, 3.4, 0.1, 0.3, 1.6, 0.3), colour: 0x4c4234 },
    { geo: trunk, matrix: at(-0.5, 2.9, -0.3, 0.26, 1.3, 0.26), colour: 0x4c4234 },
  ]);

  geo.boulder = bake([
    { geo: rock, matrix: at(0, 0.55, 0, 1.25, 0.8, 1.05, 0.4), colour: 0x7a756e },
    { geo: rock, matrix: at(0.6, 0.3, 0.4, 0.55, 0.45, 0.5, 1.7), colour: 0x6e6961 },
  ]);

  const veinBase = [
    { geo: rock, matrix: at(0, 0.6, 0, 1.35, 0.9, 1.15, 0.9), colour: 0x615d57 },
    { geo: rock, matrix: at(-0.5, 0.35, 0.5, 0.6, 0.5, 0.55, 2.2), colour: 0x6a655e },
  ];
  geo.copper_vein = bake(veinBase.concat([
    { geo: chip, matrix: at(0.4, 1.05, 0.2, 0.34), colour: 0xb87333 },
    { geo: chip, matrix: at(-0.3, 0.85, -0.5, 0.26, 0.26, 0.26, 1.1), colour: 0xc98a45 },
    { geo: chip, matrix: at(0.75, 0.6, -0.35, 0.22, 0.22, 0.22, 2.4), colour: 0xa9682d },
  ]));
  geo.tin_vein = bake(veinBase.concat([
    { geo: chip, matrix: at(0.35, 1.0, -0.25, 0.3), colour: 0xa8b0b8 },
    { geo: chip, matrix: at(-0.45, 0.8, 0.35, 0.24, 0.24, 0.24, 1.5), colour: 0xbcc4cc },
  ]));

  geo.bush = bake([
    { geo: blob, matrix: at(0, 0.5, 0, 0.7, 0.55, 0.7), colour: 0x3f6a33 },
    { geo: blob, matrix: at(0.45, 0.4, 0.25, 0.45, 0.4, 0.45, 1.3), colour: 0x477a38 },
    { geo: blob, matrix: at(-0.35, 0.45, -0.3, 0.42, 0.38, 0.42, 2.6), colour: 0x38602d },
    { geo: chip, matrix: at(0.2, 0.85, 0.3, 0.11), colour: 0xc8385c },
    { geo: chip, matrix: at(-0.3, 0.72, 0.1, 0.1, 0.1, 0.1, 1.0), colour: 0xb02f50 },
  ]);

  geo.branch = bake([
    { geo: trunk, matrix: atE(0, 0.13, 0, 0.55, 1.5, 0.55, 0, 0.3, Math.PI / 2), colour: 0x6b5236 },
    { geo: trunk, matrix: atE(0.34, 0.17, 0.2, 0.28, 0.6, 0.28, 0, 0.9, Math.PI / 2.3), colour: 0x5c4630 },
    { geo: trunk, matrix: atE(-0.3, 0.15, -0.16, 0.24, 0.5, 0.24, 0, 2.1, Math.PI / 1.8), colour: 0x634c33 },
  ]);

  geo.stone_pile = bake([
    { geo: rock, matrix: at(0, 0.17, 0, 0.36, 0.27, 0.33, 0.4), colour: 0x7f7a72 },
    { geo: rock, matrix: at(0.32, 0.12, 0.21, 0.23, 0.19, 0.21, 1.7), colour: 0x6f6a63 },
    { geo: rock, matrix: at(-0.26, 0.1, -0.19, 0.19, 0.16, 0.18, 2.6), colour: 0x8a847b },
  ]);

  // A gull nest: woven twigs, a couple of eggs, one shed feather standing up.
  const ring = new THREE.TorusGeometry(0.3, 0.09, 5, 9);
  geo.nest = bake([
    { geo: ring, matrix: at(0, 0.1, 0, 1, 1, 1), colour: 0x6b5433 },
    { geo: ring, matrix: at(0, 0.16, 0, 0.78, 0.78, 0.78, 0.9), colour: 0x7a613c },
    { geo: blob, matrix: at(0.06, 0.11, 0.03, 0.11, 0.09, 0.11), colour: 0xe6dcc4 },
    { geo: blob, matrix: at(-0.08, 0.11, -0.05, 0.1, 0.085, 0.1, 1.4), colour: 0xdcd2b8 },
    { geo: chip, matrix: at(0.22, 0.24, -0.16, 0.05, 0.2, 0.03, 2.1), colour: 0xf0ece0 },
  ]);
  ring.dispose();

  geo.flint = bake([
    { geo: chip, matrix: at(0, 0.16, 0, 0.34, 0.24, 0.34, 0.5), colour: 0x4a4a52 },
    { geo: chip, matrix: at(0.22, 0.1, 0.18, 0.2, 0.16, 0.2, 2.0), colour: 0x55555e },
  ]);

  trunk.dispose(); cone.dispose(); blob.dispose(); rock.dispose(); chip.dispose();
  return geo;
}

// --- tool resolution ------------------------------------------------------

/**
 * Accepts a bare capability string ('chop'), a weapon id, a WeaponDef or an
 * ItemDef — combat and inventory each hold a different one of those.
 */
function toolInfo(tool) {
  if (!tool) return null;
  if (typeof tool === 'string') {
    const w = WEAPONS[tool];
    if (w) return { tools: w.tool || null, tier: w.toolTier || 0 };
    return { tools: { [tool]: 1 }, tier: 99 };
  }
  let w = tool;
  if (typeof tool.weapon === 'string') w = WEAPONS[tool.weapon] || tool;
  else if (tool.weapon && typeof tool.weapon === 'object') w = tool.weapon;
  return { tools: w.tool || null, tier: w.toolTier || 0 };
}

function hash32(a, b, seed) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

export function createResources(game, terrain) {
  const group = new THREE.Group();
  group.name = 'resources';

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const geometries = buildPropGeometries();

  const byChunk = new Map();      // chunkKey -> { key, cx, cz, nodes, groups }
  const harvested = new Map();    // nodeId -> elapsed time it was taken
  const probe = {};
  const _v = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();
  const _tint = new THREE.Color();

  function populate(key, cx, cz) {
    if (byChunk.has(key)) return byChunk.get(key);
    const rng = mulberry32(hash32(cx, cz, terrain.seed));
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const now = game.time.elapsed;
    const nodes = [];
    const buckets = new Map();

    for (let a = 0; a < ATTEMPTS; a++) {
      const x = x0 + rng() * CHUNK_SIZE;
      const z = z0 + rng() * CHUNK_SIZE;
      const spin = rng() * Math.PI * 2;
      const sr = rng();
      const kindRoll = rng();

      terrain.probe(x, z, probe);
      if (probe.slope > MAX_SLOPE) continue;

      const biome = probe.biome;
      // Beaches only carry flint and the odd bush; everything else needs soil.
      if (biome === 'ocean') continue;
      if (probe.y < 0.35 && biome !== 'mire') continue;
      if (biome === 'mire' && probe.y < -1.6) continue;

      const table = SCATTER[biome];
      if (!table || !table.length) continue;
      let roll = kindRoll;
      let kind = null;
      for (let i = 0; i < table.length; i++) {
        roll -= table[i][1];
        if (roll <= 0) { kind = table[i][0]; break; }
      }
      if (!kind) continue;
      if (biome !== 'shore' && kind === 'flint') continue;
      if (biome === 'shore' && probe.y > SHORE_BAND + 1.2) continue;

      const def = NODE_KINDS[kind];
      const id = `${key}|${kind}|${a}`;
      const taken = harvested.get(id);
      if (taken != null) {
        if (now - taken < RESPAWN_SECONDS) continue;
        harvested.delete(id);
      }

      const scale = lerp(def.scale[0], def.scale[1], sr);
      const node = {
        id, kind,
        position: new THREE.Vector3(x, probe.y, z),
        hp: def.hp, maxHp: def.hp,
        tool: def.tool, tier: def.tier,
        chunkKey: key,
        drops: def.drops,
        radius: def.radius * scale,
        skill: def.skill,
        scale, spin,
        biome,
      };
      nodes.push(node);
      let b = buckets.get(kind);
      if (!b) { b = []; buckets.set(kind, b); }
      b.push(node);
    }

    const groups = new Map();
    for (const [kind, list] of buckets) {
      const mesh = new THREE.InstancedMesh(geometries[kind], material, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.userData.kind = kind;
      mesh.userData.chunkKey = key;
      group.add(mesh);
      groups.set(kind, { mesh, list });
      writeInstances(groups.get(kind));
    }

    const entry = { key, cx, cz, nodes, groups };
    byChunk.set(key, entry);
    return entry;
  }

  function writeInstances(g) {
    const { mesh, list } = g;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      _e.set(0, n.spin, 0);
      _q.setFromEuler(_e);
      _s.set(n.scale, n.scale, n.scale);
      _v.copy(n.position);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
      const t = 0.88 + ((n.spin * 7) % 1) * 0.22;
      _tint.setRGB(t, t, t);
      mesh.setColorAt(i, _tint);
    }
    mesh.count = list.length;
    mesh.visible = list.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  function unload(key) {
    const entry = byChunk.get(key);
    if (!entry) return;
    for (const g of entry.groups.values()) {
      group.remove(g.mesh);
      g.mesh.dispose();
    }
    byChunk.delete(key);
  }

  // --- felling ---------------------------------------------------------------
  // A chopped tree topples on its own mesh for a moment before it's gone. The
  // drops are already in your pack by then — this is theatre, not simulation.
  const falling = [];
  const FALL_TIME = 1.15;
  const LINGER = 0.45;

  function startFall(node) {
    const geometry = geometries[node.kind];
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(node.position);
    mesh.rotation.y = node.spin;
    mesh.scale.setScalar(node.scale);
    mesh.castShadow = true;
    mesh.userData.noCameraCollision = true;
    group.add(mesh);

    // Fall away from whoever felled it, or due north if nobody is about.
    const p = game.player?.position;
    let dx = p ? node.position.x - p.x : 0;
    let dz = p ? node.position.z - p.z : 1;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;

    falling.push({
      mesh, t: 0, spin: node.spin,
      // Tipping axis is horizontal and perpendicular to the fall direction.
      axis: new THREE.Vector3(dz, 0, -dx).normalize(),
      base: node.position.clone(),
    });
  }

  const _fallQuat = new THREE.Quaternion();
  const _spinQuat = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);

  function updateFalling(dt) {
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      f.t += dt;
      // Slow tip, then it goes over: the classic timber arc.
      const k = Math.min(1, f.t / FALL_TIME);
      const eased = k * k * (1.1 - 0.1 * k);
      const angle = eased * (Math.PI / 2);
      _spinQuat.setFromAxisAngle(_up, f.spin);
      _fallQuat.setFromAxisAngle(f.axis, angle);
      f.mesh.quaternion.copy(_fallQuat).multiply(_spinQuat);

      if (f.t > FALL_TIME + LINGER) {
        group.remove(f.mesh);
        falling.splice(i, 1);
      }
    }
  }

  function remove(node) {
    const entry = byChunk.get(node.chunkKey);
    if (!entry) return;
    const i = entry.nodes.indexOf(node);
    if (i >= 0) entry.nodes.splice(i, 1);
    const g = entry.groups.get(node.kind);
    if (!g) return;
    const j = g.list.indexOf(node);
    if (j >= 0) g.list.splice(j, 1);
    writeInstances(g);
  }

  function near(pos, radius) {
    const out = [];
    const r2 = radius * radius;
    const c0 = Math.floor((pos.x - radius) / CHUNK_SIZE);
    const c1 = Math.floor((pos.x + radius) / CHUNK_SIZE);
    const d0 = Math.floor((pos.z - radius) / CHUNK_SIZE);
    const d1 = Math.floor((pos.z + radius) / CHUNK_SIZE);
    for (let cz = d0; cz <= d1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const entry = byChunk.get(`${cx},${cz}`);
        if (!entry) continue;
        for (const n of entry.nodes) {
          const dx = n.position.x - pos.x;
          const dz = n.position.z - pos.z;
          const dy = n.position.y - pos.y;
          const pad = n.radius;
          if (dx * dx + dy * dy + dz * dz <= r2 + pad * pad + 2 * radius * pad) out.push(n);
        }
      }
    }
    return out;
  }

  function nearest(pos, radius, filter) {
    let best = null, bestD = Infinity;
    for (const n of near(pos, radius)) {
      if (filter && !filter(n)) continue;
      const d = n.position.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  function rollDrops(node, rng) {
    const out = [];
    for (const d of node.drops) {
      const count = d.min + Math.floor(rng() * (d.max - d.min + 1));
      if (count > 0) out.push({ item: d.item, count });
    }
    return out;
  }

  let dropSalt = 1;

  function damage(node, amount, tool) {
    if (!node || node.hp <= 0) return { destroyed: false, drops: [] };
    const info = toolInfo(tool);
    const byHand = node.tier === 0 && node.tool === 'pick';
    if (!byHand) {
      if (!info || !info.tools || !info.tools[node.tool]) {
        return { destroyed: false, drops: [], blocked: true, reason: 'tool' };
      }
      if ((info.tier || 0) < node.tier) {
        return { destroyed: false, drops: [], blocked: true, reason: 'tier' };
      }
    }

    node.hp -= Math.max(0, amount || 0);
    if (node.hp > 0) {
      return { destroyed: false, drops: [] };
    }

    node.hp = 0;
    if (node.tool === 'chop') startFall(node);
    const rng = mulberry32(hash32(node.position.x * 16 | 0, node.position.z * 16 | 0,
      terrain.seed + (dropSalt++)));
    const drops = rollDrops(node, rng);
    harvested.set(node.id, game.time.elapsed);
    remove(node);
    game.bus.emit('resource:harvested', {
      node, kind: node.kind, tool: node.tool, skill: node.skill,
      position: node.position, drops,
    });
    return { destroyed: true, drops };
  }

  return {
    group, material, byChunk,
    populate, unload, near, nearest, damage,
    update: updateFalling,
    kinds: NODE_KINDS,
    /** Nodes loaded right now — handy for debug overlays. */
    count() { let n = 0; for (const e of byChunk.values()) n += e.nodes.length; return n; },
    serialize() {
      const out = [];
      for (const [id, t] of harvested) out.push([id, t]);
      return { harvested: out };
    },
    hydrate(data) {
      if (!data || !Array.isArray(data.harvested)) return;
      harvested.clear();
      for (const [id, t] of data.harvested) harvested.set(id, t);
      for (const key of [...byChunk.keys()]) {
        const e = byChunk.get(key);
        const { cx, cz } = e;
        unload(key);
        populate(key, cx, cz);
      }
    },
    dispose() {
      for (const f of falling) group.remove(f.mesh);
      falling.length = 0;
      for (const key of [...byChunk.keys()]) unload(key);
      for (const k in geometries) geometries[k].dispose();
      material.dispose();
    },
  };
}
