/**
 * Shared solid-world response for anything that walks: the player and every
 * enemy run the same pass. Trees and rocks are upright cylinders (their own
 * harvest radius); build pieces are oriented boxes you can step onto when
 * their top is within a stride, and are pushed out of otherwise.
 *
 * Returns the height of the highest walkable surface under the body, or
 * -Infinity when there is none — callers decide what standing means for them.
 */
export function resolveBodyCollisions(game, body, opts = {}) {
  const radius = opts.radius ?? 0.4;
  const height = opts.height ?? 1.8;
  const step = opts.step ?? 0.6;
  const pos = body.position;
  const vel = body.velocity;

  /** Cancels the part of the velocity heading into a surface. */
  function killInward(nx, nz) {
    if (!vel) return;
    const into = vel.x * nx + vel.z * nz;
    if (into < 0) { vel.x -= into * nx; vel.z -= into * nz; }
  }

  const res = game.world?.resources;
  if (res?.near) {
    for (const node of res.near(pos, radius + 3) ?? []) {
      if (node.tool === 'pick') continue;      // berries, flint, branches: step over them
      const r = (node.radius ?? 0.5) + radius;
      let dx = pos.x - node.position.x;
      let dz = pos.z - node.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= r * r) continue;
      let dist = Math.sqrt(distSq);
      if (dist < 1e-4) { dx = 1; dz = 0; dist = 1; }
      const nx = dx / dist, nz = dz / dist;
      pos.x = node.position.x + nx * r;
      pos.z = node.position.z + nz * r;
      killInward(nx, nz);
    }
  }

  let platform = -Infinity;
  const pieces = game.building?.pieces;
  if (pieces) {
    for (const piece of pieces) {
      if (piece.door && piece.open) continue;
      const [w, h, d] = piece.def.size;
      const dx = pos.x - piece.position.x;
      const dz = pos.z - piece.position.z;
      const reach = Math.max(w, d) * 0.75 + radius;
      if (dx * dx + dz * dz > reach * reach) continue;

      // World offset into the piece's own frame.
      const cos = Math.cos(piece.rotationY), sin = Math.sin(piece.rotationY);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      const halfW = w / 2 + radius;
      const halfD = d / 2 + radius;
      if (Math.abs(lx) >= halfW || Math.abs(lz) >= halfD) continue;

      const bottom = piece.position.y - h / 2;
      let top = piece.position.y + h / 2;
      if (piece.def.stairs) {
        // Physically a ramp climbing along +Z, whatever the treads look like.
        // Measured on the piece's true depth, not the body-inflated one, so the
        // last tread really is at full height and you can step straight off it
        // onto a floor rather than having to jump.
        const along = (lz + d / 2) / d;
        top = bottom + h * Math.min(1, Math.max(0, along));
      }
      if (top <= pos.y + step) {                 // a floor, not a wall
        if (top > platform) platform = top;
        continue;
      }
      if (bottom >= pos.y + height) continue;    // clears overhead

      // Push out along whichever local axis we are least deep into.
      const penX = halfW - Math.abs(lx);
      const penZ = halfD - Math.abs(lz);
      const useX = penX < penZ;
      const nlx = useX ? (Math.sign(lx) || 1) : 0;
      const nlz = useX ? 0 : (Math.sign(lz) || 1);
      const pen = useX ? penX : penZ;
      const nx = nlx * cos + nlz * sin;
      const nz = -nlx * sin + nlz * cos;
      pos.x += nx * pen;
      pos.z += nz * pen;
      killInward(nx, nz);
    }
  }

  return platform;
}
