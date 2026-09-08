export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const randRange = (rng, a, b) => a + rng() * (b - a);
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
export const TAU = Math.PI * 2;

/** Shortest signed angle from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** True if `point` lies within `arc` radians of the direction `forward` (both XZ). */
export function inArc(fromX, fromZ, forwardX, forwardZ, px, pz, arc) {
  const dx = px - fromX, dz = pz - fromZ;
  const len = Math.hypot(dx, dz) || 1e-6;
  const dot = (dx / len) * forwardX + (dz / len) * forwardZ;
  return dot >= Math.cos(arc * 0.5);
}
