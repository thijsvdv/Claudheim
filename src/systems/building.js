import * as THREE from 'three';
import { BUILD_PIECES, getPiece } from '../data/recipes.js';
import { clamp, damp } from '../core/math.js';
import { createWheelNotcher } from '../core/wheel.js';

const GRID = 2; // metres, matches the piece footprint
const ROTATE_STEP = Math.PI / 4; // 45 degrees
const REACH = 6; // metres: ghost snapping, placement and removal all use this
const SNAP_RADIUS = 1.6; // metres: how far the ghost will jump to meet a neighbour's edge
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

  // Connection points: the centre of each face, in the piece's own frame. Two
  // pieces "click" when one of the ghost's anchors lands on one of theirs,
  // which is what makes a wall at 45 degrees still meet its neighbour's end.
  const anchorCache = new Map();
  function localAnchors(def) {
    let list = anchorCache.get(def.id);
    if (!list) {
      const [w, h, d] = def.size;
      list = [new THREE.Vector3(0, h / 2, 0), new THREE.Vector3(0, -h / 2, 0)];
      // A thin horizontal axis is a panel's broad face — joining wall to wall
      // through it would bury one plane inside the other, so those faces don't
      // offer a connection. Vertical faces always do: that's how a wall stands
      // on a floor and a beam stacks on a beam.
      if (w >= 0.4) list.push(new THREE.Vector3(w / 2, 0, 0), new THREE.Vector3(-w / 2, 0, 0));
      if (d >= 0.4) list.push(new THREE.Vector3(0, 0, d / 2), new THREE.Vector3(0, 0, -d / 2));
      anchorCache.set(def.id, list);
    }
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

  /**
   * Ghost position that puts one of its anchors on a neighbour's anchor, or
   * null when nothing is close enough. Rotation is whatever the player chose —
   * we only move the piece, never turn it.
   */
  function snapToNeighbour(def, rotationY, aim) {
    if (!snappable(def)) return null;
    const local = localAnchors(def);
    const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
    let best = null;
    let bestDistSq = SNAP_RADIUS * SNAP_RADIUS;
    for (const p of pieces) {
      if (!p.anchors || p.position.distanceToSquared(aim) > 36) continue;
      for (const a of p.anchors) {
        for (const b of local) {
          const bx = b.x * cos + b.z * sin;
          const bz = -b.x * sin + b.z * cos;
          const px = a.x - bx, py = a.y - b.y, pz = a.z - bz;
          const dx = px - aim.x, dy = py - aim.y, dz = pz - aim.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            (best ??= new THREE.Vector3()).set(px, py, pz);
          }
        }
      }
    }
    return best;
  }

  let handleGeo = null, handleMat = null;
  function doorHandleGeometry() {
    handleGeo ??= new THREE.CylinderGeometry(0.028, 0.028, 0.09, 8);
    return handleGeo;
  }
  function doorHandleMaterial() {
    handleMat ??= new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.45, metalness: 0.6 });
    return handleMat;
  }

  function makePieceGeometry(def) {
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
      const light = new THREE.PointLight(0xffb066, 1.2, 9, 2);
      light.position.copy(position).add(new THREE.Vector3(0, def.size[1] * 0.5 + 0.3, 0));
      light.userData.baseIntensity = 1.2;
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
    aimOrigin();
    rayEnd.copy(camDir).multiplyScalar(REACH).add(camPos);

    const groundY = game.world?.heightAt ? game.world.heightAt(rayEnd.x, rayEnd.z) : 0;
    if (rayEnd.y < groundY) rayEnd.y = groundY;

    // First ask the neighbours: an edge-to-edge fit beats the world grid, and
    // it's the only thing that works once a piece is turned off-axis.
    const snapped = snapToNeighbour(def, ghostRotation, rayEnd);
    let restY = groundY;   // the surface the piece ends up sitting on
    if (snapped) {
      ghost.position.copy(snapped);
      restY = snapped.y - def.size[1] / 2;
    } else {
      const snappedX = Math.round(rayEnd.x / GRID) * GRID;
      const snappedZ = Math.round(rayEnd.z / GRID) * GRID;

      // Nothing to click onto: fall back to the grid, stacking on the tallest
      // piece already in this cell, else the ground.
      let topY = groundY;
      for (const p of pieces) {
        if (Math.abs(p.position.x - snappedX) < 1.1 && Math.abs(p.position.z - snappedZ) < 1.1) {
          const top = p.position.y + p.def.size[1] / 2;
          if (top > topY) topY = top;
        }
      }
      ghost.position.set(snappedX, topY + def.size[1] / 2, snappedZ);
      restY = topY;
    }
    ghost.rotation.y = ghostRotation;
    ghost.userData.position.copy(ghost.position);
    ghost.userData.rotationY = ghostRotation;

    const cost = costFor(def);
    const blocked = pieces.some((p) => p.position.distanceTo(ghost.position) < 0.5);
    const grounded = Math.abs(restY - groundY) < GROUND_TOLERANCE;
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
    get ghostValid() { return !!ghost.userData.valid; },
    get ghostReason() { return ghost.userData.reason ?? null; },
    get debugColours() { return debugColours; },
    set debugColours(v) { setDebugColours(v); },
    toggleDebugColours: () => setDebugColours(!debugColours),

    fixedUpdate(dt) {
      const hammerEquipped = !!game.inventory?.equipped?.builder;
      if (game.input.wasPressed('build')) manualToggle = !manualToggle;
      const wantBuildMode = hammerEquipped || manualToggle;
      if (wantBuildMode !== buildMode) {
        buildMode = wantBuildMode;
        ghost.visible = buildMode;
      }

      if (buildMode) {
        if (game.input.wasPressed('rotate')) ghostRotation = (ghostRotation + ROTATE_STEP) % (Math.PI * 2);
        const step = wheel.take(dt);
        if (step) pieceIndex = (pieceIndex + step + BUILD_PIECES.length) % BUILD_PIECES.length;
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
