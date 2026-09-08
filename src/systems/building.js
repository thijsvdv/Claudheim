import * as THREE from 'three';
import { BUILD_PIECES, getPiece } from '../data/recipes.js';
import { clamp, damp } from '../core/math.js';
import { createWheelNotcher } from '../core/wheel.js';

const GRID = 2; // metres, matches the piece footprint
const ROTATE_STEP = Math.PI / 4; // 45 degrees
const REACH = 6;          // metres: how far away you can remove a piece
const DIST_MIN = 1.5, DIST_MAX = 9, DIST_STEP = 0.5;
const HEIGHT_MIN = -3, HEIGHT_MAX = 8, HEIGHT_STEP = 0.25;
const SNAP_RADIUS = 2.2; // metres: how far from the cursor a snap point can be and still win
const ADJACENCY_RADIUS = 3.0; // metres between piece centres to count as "connected"
const GROUND_TOLERANCE = 0.4; // metres of slack between a piece's underside and the terrain
const COLLAPSE_THRESHOLD = 0.05;
const DOOR_OPEN_ANGLE = 1.7; // radians (~97 degrees), swung around the piece's own centre
const DEFAULT_INTEGRITY = 0.6; // stations/hearth lack an `integrity` field in data/recipes.js

/**
 * Snap-grid building with a Valheim-style load-bearing integrity system.
 *
 * Placement uses a lightweight heuristic rather than full mesh raycasting:
 * the aim ray is projected to a fixed reach distance, then snapped to the
 * 2 m grid and to the tallest compatible piece already occupying that cell
 * (or the terrain, if none). It gets most of the "snap to existing pieces"
 * feel without needing per-face collision geometry.
 */
export function makePieceGeometry(def) {
  if (!def.stairs) return new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);

  // Stairs climb along +Z: eight treads under the same 2x2x2 envelope the
  // snapping and support code assumes, so they stack like any other piece.
  const [w, h, d] = def.size;
  const steps = 8;
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const stepH = (h / steps) * (i + 1);
    const g = new THREE.BoxGeometry(w, stepH, d / steps);
    g.translate(0, -h / 2 + stepH / 2, -d / 2 + (d / steps) * (i + 0.5));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** Minimal position-only merge: every part here is a plain BoxGeometry. */
function mergeGeometries(parts) {
  let vertexCount = 0;
  for (const g of parts) vertexCount += g.attributes.position.count;
  const pos = new Float32Array(vertexCount * 3);
  const nrm = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = [];
  let vOffset = 0, pOffset = 0, uOffset = 0;
  for (const g of parts) {
    const gp = g.attributes.position.array;
    const gn = g.attributes.normal.array;
    const gu = g.attributes.uv.array;
    pos.set(gp, pOffset); nrm.set(gn, pOffset); uv.set(gu, uOffset);
    const gi = g.index ? g.index.array : null;
    const count = g.attributes.position.count;
    if (gi) for (let i = 0; i < gi.length; i++) index.push(gi[i] + vOffset);
    else for (let i = 0; i < count; i++) index.push(i + vOffset);
    vOffset += count; pOffset += gp.length; uOffset += gu.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(index);
  out.computeBoundingSphere();
  return out;
}

/**
 * Do two upright boxes actually intersect? Separating-axis test on the four
 * horizontal axes plus the vertical interval, with a small tolerance so pieces
 * that merely touch faces count as adjacent rather than overlapping.
 */
function boxesOverlap(a, b, tol = 0.06) {
  const aTop = a.y + a.h / 2, aBot = a.y - a.h / 2;
  const bTop = b.y + b.h / 2, bBot = b.y - b.h / 2;
  if (aTop - tol <= bBot || bTop - tol <= aBot) return false;

  const ax = Math.cos(a.rot), az = -Math.sin(a.rot);
  const bx = Math.cos(b.rot), bz = -Math.sin(b.rot);
  const axes = [
    [ax, az], [-az, ax],          // a's local x and z, in world
    [bx, bz], [-bz, bx],
  ];
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ux, uz] of axes) {
    const ra = (a.w / 2) * Math.abs(ux * ax + uz * az) + (a.d / 2) * Math.abs(ux * -az + uz * ax);
    const rb = (b.w / 2) * Math.abs(ux * bx + uz * bz) + (b.d / 2) * Math.abs(ux * -bz + uz * bx);
    if (Math.abs(dx * ux + dz * uz) >= ra + rb - tol) return false;
  }
  return true;
}

export function createBuilding(game) {
  const pieces = [];
  const byId = new Map();
  const stations = [];
  const fires = [];
  let nextId = 1;

  let buildMode = false;
  let manualToggle = false;
  let pieceIndex = 0;
  let ghostRotation = 0;
  let buildDistance = 4;
  let buildHeight = 0;
  let debugColours = false;
  const wheel = createWheelNotcher();

  // Scratch vectors reused every frame — never allocate inside update loops.
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const rayEnd = new THREE.Vector3();

  const materials = { wood: makeMaterial(makeWoodTexture(), 0x8a6238), stone: makeMaterial(makeStoneTexture(), 0x8d8d8d) };
  const ghost = buildGhostMesh();
  ghost.visible = false;
  game.scene.add(ghost);

  // --- procedural materials ------------------------------------------------

  function makeWoodTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#8a6238';
    c.fillRect(0, 0, size, size);
    c.strokeStyle = 'rgba(50,30,10,0.35)';
    for (let i = 0; i < 10; i++) {
      const y = (i / 10) * size + Math.sin(i) * 2;
      c.lineWidth = 1 + (i % 3);
      c.beginPath();
      c.moveTo(0, y);
      c.bezierCurveTo(size * 0.3, y + 3, size * 0.6, y - 3, size, y);
      c.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeStoneTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#8d8d8d';
    c.fillRect(0, 0, size, size);
    for (let i = 0; i < 220; i++) {
      const v = 90 + Math.floor(Math.random() * 90);
      c.fillStyle = `rgb(${v},${v},${v})`;
      c.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeMaterial(map, colour) {
    return new THREE.MeshStandardMaterial({ map, color: colour, roughness: 0.9, metalness: 0.05 });
  }

  function materialKindFor(def) {
    if (def.material) return def.material;
    return def.id === 'workbench' ? 'wood' : 'stone';
  }

  function buildGhostMesh() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0x40ff70, transparent: true, opacity: 0.45, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    mesh.userData.position = new THREE.Vector3();
    return mesh;
  }

  // --- economy ---------------------------------------------------------------

  function costFor(def) {
    const mult = game.progression?.effects?.buildCostMult ?? 1;
    const cost = {};
    for (const [id, amount] of Object.entries(def.cost ?? {})) cost[id] = Math.ceil(amount * mult);
    return cost;
  }

  function canAfford(cost) {
    for (const [id, amount] of Object.entries(cost)) {
      if ((game.inventory?.count(id) ?? 0) < amount) return false;
    }
    return true;
  }

  // --- piece lifecycle ---------------------------------------------------------------

  // Snap points: eight corners, the midpoint of each of the twelve edges, and
  // the centre — the same set on every piece, in its own frame.
  const anchorCache = new Map();
  function localAnchors(def) {
    let list = anchorCache.get(def.id);
    if (list) return list;
    const [w, h, d] = def.size;
    const xs = [-w / 2, 0, w / 2];
    const ys = [-h / 2, 0, h / 2];
    const zs = [-d / 2, 0, d / 2];
    list = [];
    for (const x of xs) for (const y of ys) for (const z of zs) {
      // Two zeros is a face centre: it sits inside a face rather than on its
      // rim, and only ever competes with the edge points around it.
      const zeros = (x === 0 ? 1 : 0) + (y === 0 ? 1 : 0) + (z === 0 ? 1 : 0);
      if (zeros === 2) continue;
      list.push(new THREE.Vector3(x, y, z));
    }
    anchorCache.set(def.id, list);
    return list;
  }

  /** Stations and the hearth sit on the ground on their own terms. */
  function snappable(def) { return !def.station && !def.bindsSpawn; }

  function worldAnchors(def, position, rotationY) {
    const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
    return localAnchors(def).map((a) => new THREE.Vector3(
      position.x + a.x * cos + a.z * sin,
      position.y + a.y,
      position.z - a.x * sin + a.z * cos,
    ));
  }

  const _boxA = { x: 0, y: 0, z: 0, w: 0, h: 0, d: 0, rot: 0 };
  const _boxB = { x: 0, y: 0, z: 0, w: 0, h: 0, d: 0, rot: 0 };

  function collidesWithPieces(def, rotationY, x, y, z, ignore) {
    _boxA.x = x; _boxA.y = y; _boxA.z = z; _boxA.rot = rotationY;
    [_boxA.w, _boxA.h, _boxA.d] = def.size;
    for (const p of pieces) {
      if (p === ignore) continue;
      const dx = p.position.x - x, dz = p.position.z - z;
      if (dx * dx + dz * dz > 36) continue;
      _boxB.x = p.position.x; _boxB.y = p.position.y; _boxB.z = p.position.z; _boxB.rot = p.rotationY;
      [_boxB.w, _boxB.h, _boxB.d] = p.def.size;
      if (boxesOverlap(_boxA, _boxB)) return true;
    }
    return false;
  }

  /**
   * Snap the way a hand would: find the snap point on an existing piece nearest
   * to where you're pointing, then hang the ghost off whichever of its own snap
   * points puts it closest to the aim. Rotation is always yours; only the
   * position moves. Returns null when nothing is near enough, or when snapping
   * is held off.
   */
  function snapToNeighbour(def, rotationY, aim) {
    if (!snappable(def)) return null;
    const ranked = [];
    for (const p of pieces) {
      if (!p.anchors) continue;
      if (p.position.distanceToSquared(aim) > 64) continue;
      for (const a of p.anchors) {
        const dsq = a.distanceToSquared(aim);
        if (dsq <= SNAP_RADIUS * SNAP_RADIUS) ranked.push({ a, dsq });
      }
    }
    if (!ranked.length) return null;
    ranked.sort((x, y) => x.dsq - y.dsq);
    return fitToTargets(def, rotationY, aim, ranked, 12);
  }

  function instantiatePiece(def, position, rotationY, id, paidCost, open) {
    const baseMaterial = materials[materialKindFor(def)];
    const meshMaterial = baseMaterial.clone();
    meshMaterial.userData.baseColor = baseMaterial.color.clone();
    const [w, h, d] = def.size;

    let mesh;
    let panel = null;
    let hinge = null;
    if (def.door) {
      // The frame stays put and the leaf turns inside it: jambs fill the gap a
      // 1.6 m door leaves in a 2 m wall bay, and stand a little proud of the
      // wall face so the opening reads as a doorway rather than a hole.
      mesh = new THREE.Group();

      const bay = 2;                                  // the wall width it sits in
      const jambW = Math.max(0.12, (bay - w) / 2);
      const jambD = d + 0.08;
      for (const side of [1, -1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(jambW, h, jambD), meshMaterial);
        jamb.position.set(side * (w / 2 + jambW / 2), 0, 0);
        jamb.castShadow = true;
        jamb.receiveShadow = true;
        mesh.add(jamb);
      }

      hinge = new THREE.Group();
      hinge.position.set(-w / 2, 0, 0);
      mesh.add(hinge);

      panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), meshMaterial);
      panel.position.set(w / 2, 0, 0);
      panel.castShadow = true;
      panel.receiveShadow = true;
      hinge.add(panel);

      for (const side of [1, -1]) {
        const handle = new THREE.Mesh(doorHandleGeometry(), doorHandleMaterial());
        handle.userData.shared = true;
        handle.position.set(w - 0.18, -0.05, side * (d / 2 + 0.035));
        handle.rotation.x = Math.PI / 2;
        handle.castShadow = true;
        hinge.add(handle);
      }

      mesh.position.copy(position);
    } else {
      mesh = new THREE.Mesh(makePieceGeometry(def), meshMaterial);
      mesh.position.copy(position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    mesh.rotation.y = rotationY;
    mesh.traverse((o) => { o.userData.pieceId = id; });
    game.scene.add(mesh);

    const piece = {
      id, defId: def.id, def, position: position.clone(), rotationY,
      mesh, support: 0, paidCost: paidCost || {},
      door: !!def.door, open: !!open, doorVisual: open ? 1 : 0,
      panel, hinge,
      light: null, station: null, fire: null,
      anchors: snappable(def) ? worldAnchors(def, position, rotationY) : null,
    };

    if (def.light) {
      // A fire is the only thing holding the dark off, so it needs to carry:
      // a campfire lights a camp, a hearth lights a hall.
      const intensity = def.fire ? 9 : 12;
      const range = def.fire ? 22 : 30;
      const light = new THREE.PointLight(0xffb066, intensity, range, 2);
      light.position.copy(position).add(new THREE.Vector3(0, def.size[1] * 0.5 + 0.5, 0));
      light.castShadow = false;
      light.userData.baseIntensity = intensity;
      light.userData.phase = Math.random() * Math.PI * 2;
      game.scene.add(light);
      piece.light = light;
    }

    if (def.station) {
      const st = { id, kind: def.station, position: piece.position, radius: def.radius ?? 8 };
      stations.push(st);
      piece.station = st;
    }

    if (def.fire) {
      const f = { position: piece.position, radius: def.radius ?? 4 };
      fires.push(f);
      piece.fire = f;
    }

    if (def.bindsSpawn && game.player) game.player.bindPoint = piece.position.clone();

    pieces.push(piece);
    byId.set(id, piece);
    return piece;
  }

  function disposePieceMesh(piece) {
    game.scene.remove(piece.mesh);
    // A door is several meshes sharing one material (and the handles share a
    // geometry with every other door), so dispose each resource exactly once.
    const geos = new Set(), mats = new Set();
    piece.mesh.traverse((o) => {
      if (!o.isMesh || o.userData.shared) return;
      if (o.geometry) geos.add(o.geometry);
      if (o.material) mats.add(o.material);
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    if (piece.light) game.scene.remove(piece.light);
  }

  function removePiece(piece, { refund } = {}) {
    if (refund) {
      for (const [id, amount] of Object.entries(piece.paidCost)) {
        const half = Math.floor(amount / 2);
        if (half > 0) game.inventory?.add(id, half);
      }
    }
    disposePieceMesh(piece);
    const idx = pieces.indexOf(piece);
    if (idx >= 0) pieces.splice(idx, 1);
    byId.delete(piece.id);
    if (piece.station) {
      const si = stations.indexOf(piece.station);
      if (si >= 0) stations.splice(si, 1);
    }
    if (piece.fire) {
      const fi = fires.indexOf(piece.fire);
      if (fi >= 0) fires.splice(fi, 1);
    }
  }

  function placeAt(def, position, rotationY) {
    const cost = costFor(def);
    if (!canAfford(cost)) return null;
    for (const [id, amount] of Object.entries(cost)) game.inventory.remove(id, amount);
    const piece = instantiatePiece(def, position, rotationY, nextId++, cost, false);
    recomputeSupportFull();
    game.bus.emit('build:placed', { id: piece.id, defId: def.id, position: piece.position.clone() });
    return piece;
  }

  // --- structural integrity ---------------------------------------------------------------

  function isGrounded(piece) {
    if (!game.world?.heightAt) return piece.position.y <= 0.6;
    const groundY = game.world.heightAt(piece.position.x, piece.position.z);
    const bottom = piece.position.y - piece.def.size[1] / 2;
    return Math.abs(groundY - bottom) < GROUND_TOLERANCE;
  }

  function isAdjacent(a, b) {
    return a.position.distanceTo(b.position) < ADJACENCY_RADIUS;
  }

  /** One relaxation pass + collapse of anything left under threshold. Returns whether anything collapsed. */
  function recomputeSupportOnce() {
    const stabilityMult = game.progression?.effects?.buildStability ?? 1;
    for (const p of pieces) p.support = isGrounded(p) ? 1 : 0;

    let changed = true;
    let iterations = 0;
    while (changed && iterations < pieces.length + 2) {
      changed = false;
      iterations++;
      for (const p of pieces) {
        if (p.support <= 0) continue;
        const integrity = p.def.integrity ?? DEFAULT_INTEGRITY;
        const outgoing = p.support * clamp(integrity * stabilityMult, 0, 1);
        for (const q of pieces) {
          if (q === p || !isAdjacent(p, q)) continue;
          if (outgoing > q.support) { q.support = outgoing; changed = true; }
        }
      }
    }

    const collapsing = pieces.filter((p) => p.support < COLLAPSE_THRESHOLD);
    for (const p of collapsing) removePiece(p, { refund: true }); // collapse drops half materials, same as a manual removal
    return collapsing.length > 0;
  }

  function recomputeSupportFull() {
    let pass = 0;
    while (recomputeSupportOnce() && pass < 10) pass++;
    if (debugColours) applyDebugColours();
  }

  function applyDebugColours() {
    for (const p of pieces) {
      const mat = (p.panel ?? p.mesh).material;
      if (debugColours) {
        const t = clamp(p.support, 0, 1);
        mat.color.setRGB(1 - t, t, 0.05);
      } else {
        mat.color.copy(mat.userData.baseColor);
      }
    }
  }

  function setDebugColours(v) {
    debugColours = !!v;
    applyDebugColours();
  }

  // --- aiming / ghost preview ---------------------------------------------------------------

  function currentDef() { return BUILD_PIECES[pieceIndex]; }

  const EYE = 1.5;
  /** Aim ray: origin at the player's eye, direction from the camera. */
  function aimOrigin() {
    game.camera.getWorldDirection(camDir);
    const p = game.player?.position;
    if (p) camPos.set(p.x, p.y + EYE, p.z);
    else game.camera.getWorldPosition(camPos);
  }

  const aimRay = new THREE.Raycaster();
  const _hitNormal = new THREE.Vector3();
  const _hitPoint = new THREE.Vector3();
  const _march = new THREE.Vector3();
  const MAX_REACH = 12;

  /** Where the ray meets the terrain, or null if it never does. */
  function marchToGround(origin, dir, maxDist) {
    const step = 0.25;
    let prev = origin.y - (game.world?.heightAt?.(origin.x, origin.z) ?? 0);
    for (let t = step; t <= maxDist; t += step) {
      _march.copy(dir).multiplyScalar(t).add(origin);
      const gap = _march.y - (game.world?.heightAt?.(_march.x, _march.z) ?? 0);
      if (gap <= 0) {
        // Bisect once or twice for a tidy contact point.
        let lo = t - step, hi = t;
        for (let k = 0; k < 4; k++) {
          const mid = (lo + hi) / 2;
          _march.copy(dir).multiplyScalar(mid).add(origin);
          const g = _march.y - (game.world?.heightAt?.(_march.x, _march.z) ?? 0);
          if (g <= 0) hi = mid; else lo = mid;
        }
        _march.copy(dir).multiplyScalar(hi).add(origin);
        return { point: _march.clone(), dist: hi, normal: new THREE.Vector3(0, 1, 0), piece: null };
      }
      prev = gap;
    }
    return null;
  }

  /**
   * What the crosshair is pointing at: the nearest placed piece, else the
   * ground. The wheel's distance acts as a leash — scroll in and the cursor
   * floats in front of whatever it would otherwise hit.
   */
  function aimHit() {
    aimOrigin();
    const reach = Math.min(MAX_REACH, Math.max(buildDistance, 1.5));

    let best = null;
    const meshes = [];
    for (const p of pieces) meshes.push(p.mesh);
    if (meshes.length) {
      aimRay.set(camPos, camDir);
      aimRay.near = 0.05;
      aimRay.far = reach;
      const hits = aimRay.intersectObjects(meshes, true);
      for (const hit of hits) {
        const piece = byId.get(hit.object.userData.pieceId);
        if (!piece) continue;
        _hitPoint.copy(hit.point);
        _hitNormal.set(0, 1, 0);
        if (hit.face) {
          _hitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
        }
        best = { piece, point: _hitPoint.clone(), normal: _hitNormal.clone(), dist: hit.distance };
        break;
      }
    }

    const ground = marchToGround(camPos, camDir, reach);
    if (ground && (!best || ground.dist < best.dist)) best = ground;

    if (!best) {
      // Nothing within reach: hang the cursor at arm's length.
      const point = camDir.clone().multiplyScalar(reach).add(camPos);
      best = { piece: null, point, normal: new THREE.Vector3(0, 1, 0), dist: reach };
    }
    // Scrolling in pulls the cursor short of the surface, for placing in front
    // of things rather than against them.
    if (buildDistance < best.dist - 0.05) {
      best = {
        piece: null, normal: new THREE.Vector3(0, 1, 0), dist: buildDistance,
        point: camDir.clone().multiplyScalar(buildDistance).add(camPos),
      };
    }
    best.point.y += buildHeight;
    return best;
  }

  /** Half the piece's extent along a world direction. */
  function extentAlong(def, rotationY, dir) {
    const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
    const [w, h, d] = def.size;
    return Math.abs(dir.x * cos + dir.z * -sin) * (w / 2)
      + Math.abs(dir.y) * (h / 2)
      + Math.abs(dir.x * sin + dir.z * cos) * (d / 2);
  }

  const _dir = new THREE.Vector3();
  const _ideal = new THREE.Vector3();

  /**
   * Snap against the piece under the crosshair.
   *
   * The snap point nearest the cursor says *where* on that piece you mean; the
   * face it belongs to says which way the new piece should go — point at a
   * wall's top edge and the next wall goes on top of it, point at its side and
   * the run continues sideways. The ghost then attaches by whichever of its own
   * points lands it closest to sitting flush against that face, skipping any
   * fit that would bury it in what's already there.
   */
  function snapToHit(def, rotationY, hit) {
    const piece = hit.piece;
    if (!piece?.anchors) return null;
    const locals = localAnchors(piece.def);

    let ti = -1, bestSq = Infinity;
    for (let i = 0; i < piece.anchors.length; i++) {
      const dsq = piece.anchors[i].distanceToSquared(hit.point);
      if (dsq < bestSq) { bestSq = dsq; ti = i; }
    }
    if (ti < 0) return null;
    const target = piece.anchors[ti];
    const lt = locals[ti];

    // Which face does that point belong to? Ignore the piece's thin axis (a
    // wall's own face) unless it has nothing else, since stacking through it
    // is never what anyone means.
    const [tw, th, td] = piece.def.size;
    const halves = [tw / 2, th / 2, td / 2];
    const rel = [lt.x / (halves[0] || 1), lt.y / (halves[1] || 1), lt.z / (halves[2] || 1)];
    const maxHalf = Math.max(...halves);

    // Cursor in the target's own frame, to break ties between equally extreme axes.
    const cos = Math.cos(piece.rotationY), sin = Math.sin(piece.rotationY);
    const dx = hit.point.x - piece.position.x;
    const dz = hit.point.z - piece.position.z;
    const cursorLocal = [
      (dx * cos - dz * sin) / (halves[0] || 1),
      (hit.point.y - piece.position.y) / (halves[1] || 1),
      (dx * sin + dz * cos) / (halves[2] || 1),
    ];

    let axis = -1, axisScore = -Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(rel[i]) < 0.999) continue;             // not on this face
      if (halves[i] < maxHalf * 0.35 && axis >= 0) continue;
      const score = Math.abs(cursorLocal[i]) + (halves[i] < maxHalf * 0.35 ? -1 : 0);
      if (score > axisScore) { axisScore = score; axis = i; }
    }
    if (axis < 0) return null;

    const sign = Math.sign(rel[axis]) || 1;
    if (axis === 0) _dir.set(cos * sign, 0, -sin * sign);
    else if (axis === 1) _dir.set(0, sign, 0);
    else _dir.set(sin * sign, 0, cos * sign);

    const reach = extentAlong(piece.def, piece.rotationY, _dir) + extentAlong(def, rotationY, _dir);
    _ideal.copy(piece.position).addScaledVector(_dir, reach);

    // Attach by one of our own points on the face that meets it, landing as
    // close to flush as the two shapes allow.
    const gcos = Math.cos(rotationY), gsin = Math.sin(rotationY);
    const fits = [];
    for (const b of localAnchors(def)) {
      const bx = b.x * gcos + b.z * gsin;
      const bz = -b.x * gsin + b.z * gcos;
      if (bx * _dir.x + b.y * _dir.y + bz * _dir.z > 0.01) continue;   // must face the target
      const px = target.x - bx, py = target.y - b.y, pz = target.z - bz;
      const ex = px - _ideal.x, ey = py - _ideal.y, ez = pz - _ideal.z;
      fits.push({ px, py, pz, dsq: ex * ex + ey * ey + ez * ez });
    }
    fits.sort((x, y) => x.dsq - y.dsq);
    for (const f of fits) {
      if (collidesWithPieces(def, rotationY, f.px, f.py, f.pz)) continue;
      return new THREE.Vector3(f.px, f.py, f.pz);
    }
    return null;
  }

  /**
   * Given candidate target points in order of preference, find the first
   * placement that doesn't collide.
   */
  function fitToTargets(def, rotationY, cursor, ranked, limit) {
    const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
    const locals = localAnchors(def);
    for (let i = 0; i < Math.min(ranked.length, limit); i++) {
      const t = ranked[i].a;
      const fits = [];
      for (const b of locals) {
        const bx = b.x * cos + b.z * sin;
        const bz = -b.x * sin + b.z * cos;
        const px = t.x - bx, py = t.y - b.y, pz = t.z - bz;
        const dx = px - cursor.x, dy = py - cursor.y, dz = pz - cursor.z;
        fits.push({ px, py, pz, dsq: dx * dx + dy * dy + dz * dz });
      }
      fits.sort((x, y) => x.dsq - y.dsq);
      for (const f of fits) {
        if (collidesWithPieces(def, rotationY, f.px, f.py, f.pz)) continue;
        return new THREE.Vector3(f.px, f.py, f.pz);
      }
    }
    return null;
  }

  function nearestAnchor(piece, point) {
    if (!piece?.anchors) return null;
    let best = null, bestSq = Infinity;
    for (const a of piece.anchors) {
      const dsq = a.distanceToSquared(point);
      if (dsq < bestSq) { bestSq = dsq; best = a; }
    }
    return best;
  }

  function updateGhost() {
    const def = currentDef();
    if (ghost.userData.defId !== def.id) {
      ghost.geometry.dispose();
      ghost.geometry = makePieceGeometry(def);
      ghost.userData.defId = def.id;
    }

    // Aim from the player's eye rather than the camera: from the camera the
    // ray meets the ground almost at the player's feet, so the ghost lands
    // under the body. Direction is still the camera's, so it tracks the
    // crosshair.
    const hit = aimHit();
    rayEnd.copy(hit.point);

    const groundY = game.world?.heightAt ? game.world.heightAt(rayEnd.x, rayEnd.z) : 0;

    // Ctrl is free placement: no snapping, just the cursor.
    const freehand = game.input?.isDown?.('crouch');
    let snapped = null;
    if (!freehand) {
      // Snap against whatever you're actually pointing at first; only fall back
      // to "nearest point anywhere" when the cursor is on open ground.
      if (hit.piece) snapped = snapToHit(def, ghostRotation, hit);
      if (!snapped) snapped = snapToNeighbour(def, ghostRotation, rayEnd);
    }
    let restY = groundY;   // the surface the piece ends up sitting on
    if (snapped) {
      ghost.position.copy(snapped);
      restY = snapped.y - def.size[1] / 2;
    } else {
      // Free ground: the piece sits where the cursor is, on the surface. No
      // world grid — the structure's own snap points are the grid.
      const x = freehand ? rayEnd.x : Math.round(rayEnd.x / GRID) * GRID;
      const z = freehand ? rayEnd.z : Math.round(rayEnd.z / GRID) * GRID;
      const surface = game.world?.heightAt ? game.world.heightAt(x, z) : groundY;
      const centreY = buildHeight !== 0
        ? Math.max(rayEnd.y, surface + def.size[1] / 2)
        : surface + def.size[1] / 2;
      ghost.position.set(x, centreY, z);
      restY = centreY - def.size[1] / 2;
    }
    ghost.rotation.y = ghostRotation;
    ghost.userData.position.copy(ghost.position);
    ghost.userData.rotationY = ghostRotation;

    const cost = costFor(def);
    const blocked = collidesWithPieces(def, ghostRotation, ghost.position.x, ghost.position.y, ghost.position.z);
    // Ground check under the piece itself, not under the cursor.
    const groundUnder = game.world?.heightAt
      ? game.world.heightAt(ghost.position.x, ghost.position.z) : groundY;
    const grounded = Math.abs(restY - groundUnder) < GROUND_TOLERANCE;
    const supported = grounded
      || pieces.some((p) => p.support > COLLAPSE_THRESHOLD && p.position.distanceTo(ghost.position) < ADJACENCY_RADIUS);
    const affordable = canAfford(cost);
    const valid = !blocked && supported && affordable;

    ghost.material.color.setHex(valid ? 0x40ff70 : 0xff4040);
    ghost.userData.valid = valid;
    // Why it can't go here, for the HUD's build strip.
    ghost.userData.reason = valid ? null
      : !affordable ? 'not enough materials'
      : blocked ? 'something is already here'
      : 'needs ground or a supported piece';
  }

  function tryPlace() {
    if (!ghost.userData.valid) return;
    placeAt(currentDef(), ghost.userData.position, ghost.userData.rotationY);
  }

  /** Closest piece whose centre lies within `radius` of the aim ray, inside `maxReach`. */
  function pickPieceAlongRay(maxReach, filter) {
    aimOrigin();
    let best = null;
    let bestDepth = Infinity;
    for (const p of pieces) {
      if (filter && !filter(p)) continue;
      scratch.copy(p.position).sub(camPos);
      const depth = scratch.dot(camDir);
      if (depth < 0 || depth > maxReach) continue;
      const perpSq = scratch.lengthSq() - depth * depth;
      const radius = Math.max(p.def.size[0], p.def.size[1], p.def.size[2]) * 0.6;
      if (perpSq <= radius * radius && depth < bestDepth) { bestDepth = depth; best = p; }
    }
    return best;
  }

  // The building system owns wheel input only while in build mode; inventory's
  // own listener steps aside for the same reason (see systems/inventory.js).
  function onWheel(e) {
    if (!game.input.locked || game.input.uiCaptured || !buildMode) return;
    wheel.add(e);
  }
  addEventListener('wheel', onWheel, { passive: true });

  return {
    name: 'building',
    pieces,
    stations,
    fires,
    get buildMode() { return buildMode; },

    /**
     * Is this ground taken by a structure? The spawner asks before dropping an
     * enemy somewhere, so nothing materialises inside your walls.
     */
    isBlocked(x, z, margin = 1) {
      for (const piece of pieces) {
        const [w, , d] = piece.def.size;
        const dx = x - piece.position.x;
        const dz = z - piece.position.z;
        const reach = Math.max(w, d) * 0.75 + margin;
        if (dx * dx + dz * dz > reach * reach) continue;
        const cos = Math.cos(piece.rotationY), sin = Math.sin(piece.rotationY);
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        if (Math.abs(lx) <= w / 2 + margin && Math.abs(lz) <= d / 2 + margin) return true;
      }
      return false;
    },

    /** Within the warmth of a lit campfire — survival and enemy AI both ask. */
    nearFire(pos, radius = 6) {
      if (!pos) return false;
      for (const f of fires) {
        const r = Math.max(radius, f.radius ?? 4);
        if (f.position.distanceToSquared(pos) <= r * r) return true;
      }
      return false;
    },

    /** Nearest fire to a point, or null. */
    fireNear(pos, radius = 20) {
      let best = null, bestSq = radius * radius;
      for (const f of fires) {
        const d = f.position.distanceToSquared(pos);
        if (d < bestSq) { bestSq = d; best = f; }
      }
      return best;
    },

    /**
     * Roof over your head and walls around you. A cheap stand-in for a real
     * enclosure test: something solid overhead whose footprint covers you, plus
     * a couple of walls close by.
     */
    isSheltered(pos) {
      if (!pos) return false;
      let roof = false;
      let walls = 0;
      for (const piece of pieces) {
        const [w, h, d] = piece.def.size;
        const dx = pos.x - piece.position.x;
        const dz = pos.z - piece.position.z;
        const distSq = dx * dx + dz * dz;

        if (!roof) {
          const cos = Math.cos(piece.rotationY), sin = Math.sin(piece.rotationY);
          const lx = dx * cos - dz * sin;
          const lz = dx * sin + dz * cos;
          const bottom = piece.position.y - h / 2;
          const above = bottom - pos.y;
          if (Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2 && above > 1.2 && above < 6) roof = true;
        }
        if (distSq < 25 && (piece.def.id.includes('wall') || piece.def.door)) walls++;
      }
      return roof && walls >= 2;
    },
    /** The piece the hammer is currently holding, for the HUD. */
    get piece() { return currentDef(); },
    get pieceId() { return currentDef().id; },
    get buildDistance() { return buildDistance; },
    get buildHeight() { return buildHeight; },
    /** Choose what the hammer is holding — the build menu calls this. */
    setPiece(id) {
      const i = BUILD_PIECES.findIndex((p) => p.id === id);
      if (i >= 0) pieceIndex = i;
      return BUILD_PIECES[pieceIndex];
    },
    get ghostValid() { return !!ghost.userData.valid; },
    get ghostReason() { return ghost.userData.reason ?? null; },
    get debugColours() { return debugColours; },
    set debugColours(v) { setDebugColours(v); },
    toggleDebugColours: () => setDebugColours(!debugColours),

    fixedUpdate(dt) {
      const hammerEquipped = !!game.inventory?.equipped?.builder;
      // With the hammer out, B belongs to the piece picker (ui/panels.js); it
      // only toggles build mode when you aren't holding one.
      if (game.input.wasPressed('build') && !hammerEquipped) manualToggle = !manualToggle;
      const wantBuildMode = hammerEquipped || manualToggle;
      if (wantBuildMode !== buildMode) {
        buildMode = wantBuildMode;
        ghost.visible = buildMode;
      }

      if (buildMode) {
        if (game.input.wasPressed('rotate')) ghostRotation = (ghostRotation + ROTATE_STEP) % (Math.PI * 2);
        const step = wheel.take(dt);
        if (step) {
          if (game.input.isDown('sprint')) {
            buildHeight = clamp(buildHeight - step * HEIGHT_STEP, HEIGHT_MIN, HEIGHT_MAX);
          } else {
            buildDistance = clamp(buildDistance - step * DIST_STEP, DIST_MIN, DIST_MAX);
          }
        }
        updateGhost();
        if (game.input.mouseWasPressed(0)) tryPlace();
        if (game.input.mouseWasPressed(2)) {
          const target = pickPieceAlongRay(REACH);
          if (target) removePiece(target, { refund: true });
        }
      } else if (game.input.wasPressed('interact')) {
        const door = pickPieceAlongRay(REACH, (p) => p.door);
        if (door) door.open = !door.open;
      }
    },

    update(dt) {
      const t = game.time.elapsed;
      for (const p of pieces) {
        if (p.door) {
          p.doorVisual = damp(p.doorVisual, p.open ? 1 : 0, 6, dt);
          if (p.hinge) p.hinge.rotation.y = p.doorVisual * DOOR_OPEN_ANGLE;
          else p.mesh.rotation.y = p.rotationY + p.doorVisual * DOOR_OPEN_ANGLE;
        }
        if (p.light) {
          const flicker = Math.sin(t * 9 + p.light.userData.phase) * 0.15
            + Math.sin(t * 23 + p.light.userData.phase) * 0.08;
          p.light.intensity = p.light.userData.baseIntensity + flicker;
        }
      }
    },

    serialize() {
      return {
        nextId,
        pieces: pieces.map((p) => ({
          id: p.id,
          defId: p.defId,
          position: [p.position.x, p.position.y, p.position.z],
          rotationY: p.rotationY,
          open: !!p.open,
          paidCost: p.paidCost,
        })),
      };
    },

    hydrate(data) {
      for (const p of [...pieces]) disposePieceMesh(p);
      pieces.length = 0;
      byId.clear();
      stations.length = 0;
      fires.length = 0;

      nextId = data?.nextId ?? 1;
      for (const pd of data?.pieces ?? []) {
        const def = getPiece(pd.defId);
        if (!def) continue;
        instantiatePiece(def, new THREE.Vector3(pd.position[0], pd.position[1], pd.position[2]), pd.rotationY, pd.id, pd.paidCost, pd.open);
      }
      recomputeSupportFull();
    },

    dispose() {
      removeEventListener('wheel', onWheel);
      for (const p of pieces) disposePieceMesh(p);
      game.scene.remove(ghost);
      ghost.geometry.dispose();
      ghost.material.dispose();
      for (const mat of Object.values(materials)) { mat.map?.dispose(); mat.dispose(); }
    },
  };
}
