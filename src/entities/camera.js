import * as THREE from 'three';
import { clamp, damp } from '../core/math.js';
import { createWheelNotcher } from '../core/wheel.js';

const MIN_DIST = 2;
const MAX_DIST = 8;
const DEFAULT_DIST = 5;
const ZOOM_STEP = 0.5;
const PITCH_LIMIT = 1.3; // radians, keeps the orbit from flipping over the pole
const LOOK_SENS = 0.0022;
const COLLIDE_MARGIN = 0.3;
const COLLIDE_LAMBDA = 14; // fast pull-in, slower push-out damping below
const RESTORE_LAMBDA = 5;
const EYE_HEIGHT = 1.55;
const SHOULDER_OFFSET = 1.0;   // metres the pivot slides sideways in build mode
const SHOULDER_LAMBDA = 7;

/**
 * Third-person orbit rig. Runs entirely in `update()` — the camera is a view
 * concern, not simulation, but it still writes `rig.forward`/`rig.right` each
 * frame for the player's `fixedUpdate` to read (one-frame-stale at worst,
 * which is imperceptible for a mouse-driven basis).
 */
export function createCameraRig(game) {
  const raycaster = new THREE.Raycaster();
  // Own wheel listener so one detent is one zoom step, the same way the build
  // list steps. input.takeLook()'s wheel field counts raw events, which on most
  // mice is three or four per click.
  const zoomWheel = createWheelNotcher();
  const onWheel = (e) => {
    if (!game.input.locked || game.input.uiCaptured) return;
    if (game.building?.buildMode) return;   // the hammer owns the wheel
    zoomWheel.add(e);
  };
  addEventListener('wheel', onWheel, { passive: true });
  const pivot = new THREE.Vector3();
  const camOffset = new THREE.Vector3();

  const rig = {
    name: 'cameraRig',
    yaw: 0,
    pitch: 0.35,
    shoulder: 0,
    targetDistance: DEFAULT_DIST,
    distance: DEFAULT_DIST,
    forward: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
  };

  rig.init = function init() {
    const p = game.player?.position;
    if (p) {
      pivot.set(p.x, p.y + EYE_HEIGHT, p.z);
      game.camera.position.copy(pivot).addScaledVector(rig.forward, -rig.distance);
      game.camera.lookAt(pivot);
    }
  };

  rig.aimRay = function aimRay() {
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(game.camera.quaternion);
    return { origin: game.camera.position.clone(), direction };
  };

  rig.dispose = function dispose() {
    removeEventListener('wheel', onWheel);
  };

  rig.update = function update(dt) {
    const player = game.player;
    if (!player) return;

    if (game.input.locked && !game.input.uiCaptured) {
      const look = game.input.takeLook();
      rig.yaw -= look.x * LOOK_SENS;
      rig.pitch = clamp(rig.pitch + look.y * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
      void look.wheel;   // drained above; zoom comes from the notched listener
    } else {
      game.input.takeLook(); // drain so a stale drag doesn't jump the view on relock
    }

    const zoomStep = zoomWheel.take(dt);
    if (zoomStep) rig.targetDistance = clamp(rig.targetDistance + zoomStep * ZOOM_STEP, MIN_DIST, MAX_DIST);

    rig.forward.set(Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
    rig.right.set(-Math.cos(rig.yaw), 0, Math.sin(rig.yaw));

    // In build mode the body stands square in front of the crosshair and hides
    // the ghost, so ease the pivot over the shoulder. The aim ray is the
    // camera's own forward axis, so the ghost stays under the crosshair.
    const wantShoulder = game.building?.buildMode ? SHOULDER_OFFSET : 0;
    rig.shoulder = damp(rig.shoulder, wantShoulder, SHOULDER_LAMBDA, dt);

    pivot.set(
      player.position.x + rig.right.x * rig.shoulder,
      player.position.y + EYE_HEIGHT,
      player.position.z + rig.right.z * rig.shoulder,
    );

    camOffset.set(
      -Math.sin(rig.yaw) * Math.cos(rig.pitch),
      Math.sin(rig.pitch),
      -Math.cos(rig.yaw) * Math.cos(rig.pitch),
    );

    const wanted = rig.targetDistance;
    let allowed = wanted;
    // Sprites (hit sparks, damage numbers) raycast against the camera plane and
    // throw without this; the collision sweep walks the whole scene.
    raycaster.camera = game.camera;
    raycaster.set(pivot, camOffset);
    raycaster.far = wanted;
    raycaster.near = 0.05;
    const hits = raycaster.intersectObjects(game.scene.children, true);
    for (const hit of hits) {
      if (hit.object.userData?.playerBody) continue;
      if (hit.object.userData?.noCameraCollision) continue;
      allowed = Math.min(allowed, Math.max(0.4, hit.distance - COLLIDE_MARGIN));
      break; // closest hit first since Raycaster results are sorted by distance
    }

    // Pull in fast so the camera never clips through geometry, ease back out
    // slower so it doesn't yo-yo when passing a doorway.
    const lambda = allowed < rig.distance ? COLLIDE_LAMBDA : RESTORE_LAMBDA;
    rig.distance = damp(rig.distance, allowed, lambda, dt);

    game.camera.position.copy(pivot).addScaledVector(camOffset, rig.distance);
    game.camera.lookAt(pivot);
  };

  return rig;
}
