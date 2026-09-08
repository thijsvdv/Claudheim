import * as THREE from 'three';
import { bake, put, heldGeometry } from '../entities/heldprops.js';
import { makePieceGeometry } from '../systems/building.js';

/**
 * Inventory icons, rendered rather than drawn: every item gets a tiny offscreen
 * WebGL pass over the same kind of low-poly sculpt the world uses, baked once
 * into a data URL and cached forever. Weapons, tools and the shield reuse the
 * exact geometry the player holds; everything else gets a sculpt from the
 * table below.
 *
 * One extra 96x96 GL context is the whole cost, and only if something actually
 * asks for an icon.
 */

const SIZE = 96;
const urls = new Map();      // itemId -> data URL | null
let gl = null;               // { renderer, scene, camera, holder }
let iconGeo = null;
let iconMat = null;
let failed = false;

const WOOD = 0x8a6238;
const DARKWOOD = 0x5e4426;
const STONE = 0x8d8d8d;
const FLINT = 0x4a4a52;
const COPPER = 0xb87333;
const TIN = 0xa8b0b8;
const BRONZE = 0xc08b45;
const MEAT = 0xa8443c;

function buildIconGeometries() {
  const rod = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const ball = new THREE.IcosahedronGeometry(1, 0);
  const smooth = new THREE.IcosahedronGeometry(1, 1);
  const shard = new THREE.TetrahedronGeometry(1, 0);
  const cone = new THREE.ConeGeometry(1, 1, 7, 1);
  const disc = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
  const g = {};

  const log = (x, y, z, len, r, colour, ry) =>
    ({ geo: rod, matrix: put(x, y, z, r, len, r, Math.PI / 2, ry || 0, 0), colour });

  g.wood = bake([
    log(0, 0.1, 0, 0.9, 0.16, WOOD, 0.1),
    log(0.05, -0.16, 0.1, 0.8, 0.14, DARKWOOD, -0.35),
    { geo: disc, matrix: put(0, 0.1, 0.46, 0.15, 0.03, 0.15, Math.PI / 2), colour: 0xc4a377 },
  ]);

  g.corewood = bake([
    log(0, 0.05, 0, 1.05, 0.2, DARKWOOD, 0.05),
    { geo: disc, matrix: put(0, 0.05, 0.54, 0.19, 0.03, 0.19, Math.PI / 2), colour: 0x8f6f45 },
    { geo: disc, matrix: put(0, 0.05, 0.56, 0.09, 0.03, 0.09, Math.PI / 2), colour: 0x5b4227 },
  ]);

  g.stone = bake([
    { geo: ball, matrix: put(0, 0, 0, 0.5, 0.4, 0.45, 0.4, 0.9, 0), colour: STONE },
    { geo: ball, matrix: put(0.38, -0.18, 0.16, 0.24, 0.2, 0.22, 1.7), colour: 0x6f6a63 },
    { geo: ball, matrix: put(-0.34, -0.2, -0.12, 0.2, 0.17, 0.19, 2.6), colour: 0x9a948b },
  ]);

  g.flint = bake([
    { geo: shard, matrix: put(0, 0.05, 0, 0.5, 0.42, 0.34, 0.3, 0.6, 0.2), colour: FLINT },
    { geo: shard, matrix: put(0.28, -0.22, 0.18, 0.26, 0.22, 0.2, 1.2, 0, 0.6), colour: 0x5c5c66 },
  ]);

  g.resin = bake([
    { geo: smooth, matrix: put(-0.1, -0.02, 0, 0.36, 0.3, 0.34), colour: 0xd9a441 },
    { geo: smooth, matrix: put(0.26, -0.16, 0.12, 0.24, 0.2, 0.22), colour: 0xe8bb60 },
    { geo: smooth, matrix: put(0.05, 0.28, -0.08, 0.18, 0.16, 0.17), colour: 0xc98f2f },
  ]);

  g.leather = bake([
    { geo: box, matrix: put(0, 0.06, 0, 0.86, 0.06, 0.62, 0.12, 0.3, 0.08), colour: 0x9c6b3f },
    { geo: box, matrix: put(0.1, -0.14, 0.12, 0.62, 0.05, 0.44, -0.1, 0.9, 0.05), colour: 0x7d5230 },
  ]);

  g.feather = bake([
    { geo: box, matrix: put(0, 0, 0, 0.03, 0.95, 0.03, 0, 0, 0.35), colour: 0xbfae90 },
    { geo: cone, matrix: put(-0.1, 0.05, 0, 0.22, 0.7, 0.03, 0, 0, 0.35), colour: 0xe4e0d6 },
  ]);

  const oreRock = (chipColour) => ([
    { geo: ball, matrix: put(0, -0.05, 0, 0.46, 0.38, 0.42, 0.4, 0.9, 0), colour: 0x6b665f },
    { geo: shard, matrix: put(0.16, 0.26, 0.1, 0.22, 0.22, 0.22, 0.4, 0.6, 0.2), colour: chipColour },
    { geo: shard, matrix: put(-0.24, 0.12, -0.14, 0.16, 0.16, 0.16, 1.1, 0, 0.5), colour: chipColour },
  ]);
  g.copper_ore = bake(oreRock(COPPER));
  g.tin_ore = bake(oreRock(TIN));

  const bar = (colour, top) => ([
    { geo: box, matrix: put(0, -0.12, 0, 0.9, 0.16, 0.42, 0, 0.5, 0), colour },
    { geo: box, matrix: put(0, 0.04, 0, 0.74, 0.16, 0.32, 0, 0.5, 0), colour: top },
  ]);
  g.copper_bar = bake(bar(0xa8692f, 0xd08a4a));
  g.bronze_bar = bake(bar(0x9d6f34, BRONZE));

  g.greydwarf_eye = bake([
    { geo: smooth, matrix: put(0, 0, 0, 0.42), colour: 0xc9d8b0 },
    { geo: smooth, matrix: put(0, 0, 0.34, 0.16, 0.16, 0.1), colour: 0x2f3a26 },
  ]);

  g.ashen_shard = bake([
    { geo: cone, matrix: put(0, 0.06, 0, 0.3, 1.0, 0.3, 0.25, 0.4, 0.15), colour: 0xff8c42 },
    { geo: shard, matrix: put(0.24, -0.3, 0.1, 0.2, 0.2, 0.2, 0.9, 0, 0.4), colour: 0xc25a1c },
  ]);

  g.raspberries = bake([
    { geo: smooth, matrix: put(-0.18, -0.08, 0, 0.28), colour: 0xc8385c },
    { geo: smooth, matrix: put(0.2, -0.14, 0.1, 0.24), colour: 0xb02f50 },
    { geo: smooth, matrix: put(0.02, 0.22, -0.06, 0.22), colour: 0xd6446a },
    { geo: box, matrix: put(0.02, 0.46, -0.06, 0.03, 0.2, 0.03, 0.2), colour: 0x4d6b32 },
  ]);

  g.mushroom = bake([
    { geo: rod, matrix: put(0, -0.24, 0, 0.14, 0.5, 0.14), colour: 0xe0d8c4 },
    { geo: smooth, matrix: put(0, 0.1, 0, 0.44, 0.3, 0.44), colour: 0xa8452f },
    { geo: smooth, matrix: put(0.14, 0.24, 0.12, 0.07, 0.04, 0.07), colour: 0xe8e0cc },
  ]);

  g.boar_meat = bake([
    { geo: smooth, matrix: put(0, -0.04, 0, 0.46, 0.32, 0.36, 0.2, 0.5, 0.3), colour: MEAT },
    { geo: smooth, matrix: put(-0.1, 0.14, 0.06, 0.3, 0.16, 0.24, 0.4), colour: 0xbd5a4e },
    { geo: rod, matrix: put(0.34, 0.2, -0.04, 0.07, 0.44, 0.07, 0, 0, 1.1), colour: 0xe6dfcc },
  ]);

  g.cooked_meat = bake([
    { geo: smooth, matrix: put(0, -0.04, 0, 0.46, 0.32, 0.36, 0.2, 0.5, 0.3), colour: 0x7a4526 },
    { geo: smooth, matrix: put(-0.1, 0.14, 0.06, 0.3, 0.16, 0.24, 0.4), colour: 0x8f5730 },
    { geo: rod, matrix: put(0.34, 0.2, -0.04, 0.07, 0.44, 0.07, 0, 0, 1.1), colour: 0xe6dfcc },
  ]);

  g.honey = bake([
    { geo: rod, matrix: put(0, -0.06, 0, 0.36, 0.62, 0.36), colour: 0xe0a828 },
    { geo: rod, matrix: put(0, 0.3, 0, 0.4, 0.1, 0.4), colour: 0xb8801c },
    { geo: rod, matrix: put(0, 0.38, 0, 0.3, 0.08, 0.3), colour: 0x6b4a2c },
  ]);

  g.wood_arrow = bake([
    { geo: rod, matrix: put(0, 0, 0, 0.035, 1.1, 0.035, 0, 0, 0.3), colour: 0x9a7c4a },
    { geo: cone, matrix: put(-0.17, 0.56, 0, 0.09, 0.24, 0.05, 0, 0, 0.3), colour: FLINT },
    { geo: box, matrix: put(0.15, -0.5, 0, 0.02, 0.26, 0.14, 0, 0, 0.3), colour: 0xe4e0d6 },
  ]);

  const runeStone = (glyph) => ([
    { geo: disc, matrix: put(0, 0, 0, 0.5, 0.12, 0.5, Math.PI / 2, 0, 0.2), colour: 0x5a5f66 },
    { geo: box, matrix: put(0, 0.04, 0.1, 0.08, 0.5, 0.08, 0, 0, 0.2), colour: glyph },
    { geo: box, matrix: put(0.04, -0.1, 0.1, 0.34, 0.08, 0.08, 0, 0, -0.5), colour: glyph },
  ]);
  g.rune_ember = bake(runeStone(0xff8c42));
  g.rune_frost = bake(runeStone(0x9fd4e8));

  rod.dispose(); box.dispose(); ball.dispose(); smooth.dispose();
  shard.dispose(); cone.dispose(); disc.dispose();
  return g;
}

function geometryFor(itemId) {
  const held = heldGeometry(itemId);
  if (held) return held;
  iconGeo ??= buildIconGeometries();
  return iconGeo[itemId] ?? null;
}

function ensureGl() {
  if (gl || failed) return gl;
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20, 20);
    camera.position.set(1.1, 1.25, 1.6);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xcfe0ea, 0x2a2620, 2.1));
    const key = new THREE.DirectionalLight(0xfff0d4, 2.6);
    key.position.set(1.4, 2.2, 1.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb6d0, 1.1);
    rim.position.set(-1.6, 0.4, -1.2);
    scene.add(rim);

    const holder = new THREE.Group();
    scene.add(holder);

    gl = { renderer, scene, camera, holder };
  } catch {
    failed = true;
    gl = null;
  }
  return gl;
}

let pieceMat = null;
const pieceGeoCache = new Map();
const pieceUrls = new Map();

/** Icon for a build piece, rendered from the geometry the world actually uses. */
export function pieceIcon(def) {
  if (!def) return null;
  if (pieceUrls.has(def.id)) return pieceUrls.get(def.id);
  let url = null;
  try {
    let geometry = pieceGeoCache.get(def.id);
    if (!geometry) { geometry = makePieceGeometry(def); pieceGeoCache.set(def.id, geometry); }
    pieceMat ??= new THREE.MeshStandardMaterial({ color: 0x9a7648, roughness: 0.75 });
    url = renderGeometry(geometry, pieceMat);
  } catch { url = null; }
  pieceUrls.set(def.id, url);
  return url;
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

function render(itemId) {
  const geometry = geometryFor(itemId);
  if (!geometry) return null;
  iconMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.06 });
  return renderGeometry(geometry, iconMat);
}

function renderGeometry(geometry, material) {
  const ctx = ensureGl();
  if (!ctx) return null;
  const mesh = new THREE.Mesh(geometry, material);

  // Frame it: centre the sculpt on the origin, then scale its longest axis to
  // fill the ortho box with a little air around the edges.
  _box.setFromBufferAttribute(geometry.attributes.position);
  _box.getSize(_size);
  _box.getCenter(_centre);
  const dims = [_size.x, _size.y, _size.z].sort((a, b) => b - a);
  const longest = dims[0] || 1;
  // Long thin things (hafts, blades, arrows) read as a hairline stood upright,
  // so lay them across the diagonal and let them fill more of the square.
  const lanky = longest / (dims[1] || 0.001) > 2.4;
  const scale = (lanky ? 1.85 : 1.5) / longest;
  mesh.position.copy(_centre).multiplyScalar(-scale);
  mesh.scale.setScalar(scale);

  const pivot = new THREE.Group();
  pivot.rotation.set(-0.14, 0.72, lanky ? -0.72 : 0);
  pivot.add(mesh);
  ctx.holder.add(pivot);
  ctx.renderer.render(ctx.scene, ctx.camera);
  ctx.holder.remove(pivot);

  return ctx.renderer.domElement.toDataURL('image/png');
}

/**
 * Data URL for an item's icon, or null if it has no sculpt (callers should
 * keep their colour swatch as the fallback). Cached per item id.
 */
export function itemIcon(itemId) {
  if (!itemId) return null;
  if (urls.has(itemId)) return urls.get(itemId);
  let url = null;
  try { url = render(itemId); } catch { url = null; }
  urls.set(itemId, url);
  return url;
}

/** Paints an element with the item's icon, falling back to a flat swatch. */
export function paintIcon(el, itemId, fallbackColour) {
  if (!el) return;
  // Called every UI tick; skip the style write when nothing changed.
  const key = itemId ?? '';
  if (el.dataset.iconId === key) return;
  el.dataset.iconId = key;
  if (!itemId) {
    el.style.backgroundImage = '';
    el.style.backgroundColor = 'transparent';
    return;
  }
  const url = itemIcon(itemId);
  if (url) {
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundColor = 'transparent';
  } else {
    el.style.backgroundImage = '';
    el.style.backgroundColor = fallbackColour;
  }
}
