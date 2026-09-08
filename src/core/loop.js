const STEP = 1 / 60;
const MAX_FRAME = 0.25; // never simulate more than 250 ms of catch-up at once

/**
 * Fixed-timestep accumulator. Simulation is deterministic at 60 Hz; render is
 * called once per animation frame with the true delta and an interpolation
 * alpha for smoothing visual transforms.
 */
export function createLoop({ fixed, render }) {
  let last = 0, acc = 0, raf = 0, running = false;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const t = now / 1000;
    let dt = last ? t - last : STEP;
    last = t;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 8) { fixed(STEP); acc -= STEP; steps++; }
    if (steps === 8) acc = 0; // we are hopelessly behind; drop the backlog

    render(dt, acc / STEP);
  }

  return {
    start() { if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); } },
    stop() { running = false; cancelAnimationFrame(raf); },
    get running() { return running; },
  };
}
