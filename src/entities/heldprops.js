import * as THREE from 'three';
import { getItem } from '../data/items.js';

/**
 * Procedural meshes for whatever the player is holding. Same trick the world
 * props use: a handful of primitives baked into one vertex-coloured geometry
 * per item, so a held tool costs one draw call and no texture.
 *
 * Local space convention: the grip sits at the origin, the haft runs up +Y and
 * the business end faces +Z. `handAnchor` on the player's right arm shares the
 * body's axes, so a small forward tilt is all that's needed to make it read as
 * "carried" rather than "impaled through the fist".
 */

let cache = null;   // itemId -> BufferGeometry (shared across respawns)
let mat = null;
let flameMat = null;

const M = () => new THREE.Matrix4();
export const put = (x, y, z, sx, sy, sz, rx, ry, rz) => {
  const m = M();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
    new THREE.Vector3(sx, sy ?? sx, sz ?? sx));
  return m;
};

export function bake(parts) {
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

const WOOD = 0x8a6238;
const DARKWOOD = 0x5e4426;
const STONE = 0x8d8d8d;
const FLINT = 0x4a4a52;
const ANTLER = 0xcbb994;
const BRONZE = 0xc08b45;
const LEATHER = 0x6b4a2c;

function buildAll() {
  const rod = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const wedge = new THREE.TetrahedronGeometry(1, 0);
  const ball = new THREE.IcosahedronGeometry(1, 0);
  const cone = new THREE.ConeGeometry(1, 1, 6, 1);
  const g = {};

  // Haft up +Y, grip at origin, blade biting forward (+Z).
  const haft = (len, r, colour) =>
    ({ geo: rod, matrix: put(0, len * 0.5 - 0.12, 0, r, len, r), colour });

  g.stone_axe = bake([
    haft(0.72, 0.022, WOOD),
    { geo: box, matrix: put(0, 0.54, 0.04, 0.05, 0.1, 0.09), colour: LEATHER },
    { geo: wedge, matrix: put(0, 0.55, 0.15, 0.17, 0.19, 0.11, 0, 0, 0.5), colour: STONE },
    { geo: box, matrix: put(0, 0.5, 0.11, 0.05, 0.18, 0.07, 0.3), colour: 0x9a958c },
  ]);

  g.pickaxe = bake([
    haft(0.8, 0.022, DARKWOOD),
    { geo: box, matrix: put(0, 0.6, 0, 0.05, 0.08, 0.08), colour: LEATHER },
    { geo: rod, matrix: put(0, 0.62, 0.14, 0.022, 0.3, 0.022, Math.PI / 2.4), colour: ANTLER },
    { geo: rod, matrix: put(0, 0.62, -0.14, 0.022, 0.3, 0.022, -Math.PI / 2.4), colour: ANTLER },
    { geo: cone, matrix: put(0, 0.5, 0.26, 0.03, 0.12, 0.03, Math.PI / 1.7), colour: ANTLER },
  ]);

  g.hammer = bake([
    haft(0.52, 0.02, WOOD),
    { geo: box, matrix: put(0, 0.4, 0, 0.09, 0.1, 0.16), colour: 0x7a756e },
    { geo: box, matrix: put(0, 0.4, 0.09, 0.07, 0.08, 0.05), colour: 0x8d8d8d },
  ]);

  g.club = bake([
    { geo: rod, matrix: put(0, 0.16, 0, 0.028, 0.5, 0.028), colour: LEATHER },
    { geo: rod, matrix: put(0, 0.48, 0, 0.055, 0.28, 0.055), colour: DARKWOOD },
    { geo: ball, matrix: put(0, 0.63, 0, 0.075, 0.09, 0.075, 0.4), colour: DARKWOOD },
  ]);

  g.flint_spear = bake([
    { geo: rod, matrix: put(0, 0.42, 0, 0.019, 1.5, 0.019), colour: WOOD },
    { geo: box, matrix: put(0, 1.06, 0, 0.026, 0.07, 0.026), colour: LEATHER },
    { geo: cone, matrix: put(0, 1.22, 0, 0.035, 0.22, 0.02), colour: FLINT },
  ]);

  g.bronze_sword = bake([
    { geo: rod, matrix: put(0, 0.07, 0, 0.022, 0.18, 0.022), colour: LEATHER },
    { geo: ball, matrix: put(0, -0.04, 0, 0.035), colour: BRONZE },
    { geo: box, matrix: put(0, 0.17, 0, 0.17, 0.03, 0.05), colour: BRONZE },
    { geo: box, matrix: put(0, 0.46, 0, 0.055, 0.56, 0.014), colour: 0xd8b26a },
    { geo: cone, matrix: put(0, 0.78, 0, 0.055, 0.12, 0.014), colour: 0xd8b26a },
  ]);

  g.bronze_mace = bake([
    { geo: rod, matrix: put(0, 0.2, 0, 0.024, 0.6, 0.024), colour: DARKWOOD },
    { geo: ball, matrix: put(0, 0.56, 0, 0.1, 0.11, 0.1, 0.6), colour: BRONZE },
    { geo: wedge, matrix: put(0, 0.56, 0.09, 0.06, 0.06, 0.06, 0.9), colour: 0xd8b26a },
    { geo: wedge, matrix: put(0.09, 0.56, 0, 0.06, 0.06, 0.06, 0, 1.4, 0.4), colour: 0xd8b26a },
  ]);

  // Limbs vertical, belly bulging forward past the fist, string on the near
  // side — the grip sits at the origin so the hand holds the bow, not the air
  // in front of it.
  const BOW_ARC = Math.PI * 0.78;
  const BOW_R = 0.42;
  const BOW_Z = -BOW_R;
  const bow = new THREE.TorusGeometry(BOW_R, 0.018, 5, 14, BOW_ARC);
  g.crude_bow = bake([
    { geo: bow, matrix: put(0, 0, BOW_Z, 1, 1, 1, 0, -Math.PI / 2, -BOW_ARC / 2), colour: DARKWOOD },
    { geo: box, matrix: put(0, 0, BOW_Z + BOW_R * Math.cos(BOW_ARC / 2),
                            0.005, 2 * BOW_R * Math.sin(BOW_ARC / 2), 0.005), colour: 0xe6ddc8 },
    { geo: rod, matrix: put(0, 0, -0.02, 0.026, 0.17, 0.026), colour: LEATHER },
  ]);
  bow.dispose();

  g.torch = bake([
    { geo: rod, matrix: put(0, 0.22, 0, 0.022, 0.62, 0.022), colour: DARKWOOD },
    { geo: rod, matrix: put(0, 0.5, 0, 0.038, 0.12, 0.038), colour: 0x2b2320 },
  ]);
  g.torch_flame = bake([
    { geo: cone, matrix: put(0, 0.62, 0, 0.055, 0.16, 0.055), colour: 0xffb347 },
  ]);

  const disc = new THREE.CylinderGeometry(0.26, 0.26, 0.05, 14, 1);
  const rim = new THREE.TorusGeometry(0.25, 0.022, 5, 16);
  g.wood_shield = bake([
    { geo: disc, matrix: put(0, 0, 0, 1, 1, 1, Math.PI / 2), colour: WOOD },
    { geo: rim, matrix: put(0, 0, 0.01, 1, 1, 1), colour: DARKWOOD },
    { geo: ball, matrix: put(0, 0, 0.06, 0.06, 0.06, 0.04), colour: 0x8d8d8d },
  ]);
  disc.dispose(); rim.dispose();

  // Anything else that can be swung but has no sculpt of its own.
  g._generic = bake([haft(0.6, 0.024, DARKWOOD)]);

  rod.dispose(); box.dispose(); wedge.dispose(); ball.dispose(); cone.dispose();
  return g;
}

function geometries() {
  if (!cache) cache = buildAll();
  return cache;
}

function material() {
  if (!mat) mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  return mat;
}

/** The baked geometry for a held item, or null if it has no sculpt. */
export function heldGeometry(itemId) {
  return geometries()[itemId] ?? null;
}

/** Item kinds that belong in a fist rather than a pocket. */
const HELDABLE = new Set(['weapon', 'tool', 'shield']);

export function isHeldable(itemId) {
  const def = getItem(itemId);
  return !!def && HELDABLE.has(def.kind);
}

/**
 * Builds the prop for `itemId`, or null if that item isn't something you hold.
 * The caller owns the returned Object3D and should dispose() it on swap —
 * geometry and material are shared, so disposal is just detaching.
 */
export function createHeldProp(itemId) {
  const def = getItem(itemId);
  if (!def || !HELDABLE.has(def.kind)) return null;

  const geo = geometries();
  const group = new THREE.Group();
  group.name = `held:${itemId}`;

  const mesh = new THREE.Mesh(geo[itemId] ?? geo._generic, material());
  mesh.castShadow = true;
  group.add(mesh);

  if (itemId === 'torch') {
    if (!flameMat) {
      flameMat = new THREE.MeshStandardMaterial({
        vertexColors: true, emissive: 0xff7b1a, emissiveIntensity: 2.4, roughness: 1,
      });
    }
    const flame = new THREE.Mesh(geo.torch_flame, flameMat);
    flame.name = 'flame';
    group.add(flame);
    const light = new THREE.PointLight(0xffa64d, 6, 14, 2);
    light.position.set(0, 0.66, 0);
    group.add(light);
    group.userData.flame = flame;
  }

  // Grip: a shield faces the way the body does, strapped across the forearm
  // and pushed clear of the torso; everything else angles forward so the head
  // clears the body during the walk cycle.
  if (def.kind === 'shield') {
    group.rotation.set(0, 0, -0.25);
    group.position.set(-0.09, 0.08, 0.02);
  } else {
    group.rotation.set(0.35, 0, 0.12);
  }

  group.userData.itemId = itemId;
  return group;
}

/** Cheap per-frame life for the torch flame; no-op for everything else. */
export function animateHeldProp(prop, elapsed) {
  const flame = prop?.userData?.flame;
  if (!flame) return;
  const f = 0.85 + Math.sin(elapsed * 11) * 0.1 + Math.sin(elapsed * 27) * 0.05;
  flame.scale.set(1, f, 1);
}
