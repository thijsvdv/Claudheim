/**
 * One physical wheel notch = one step.
 *
 * Browsers deliver a single detent as a burst of several events, in pixels,
 * lines or pages depending on the platform, so counting events (or even signs)
 * cycles three or four items per click. This normalises to pixels, waits for
 * the burst to settle, then yields exactly one step — while a continuous spin
 * still ticks along at a steady rate rather than stalling.
 */

const SETTLE = 0.06;    // seconds of quiet that ends a burst
const MAX_HOLD = 0.22;  // ...unless the wheel never stops, then step anyway
const STALE = 0.4;      // drop sub-threshold dust after this long

function pixels(e) {
  if (e.deltaMode === 1) return e.deltaY * 16;   // lines
  if (e.deltaMode === 2) return e.deltaY * 100;  // pages
  return e.deltaY;
}

export function createWheelNotcher(threshold = 36) {
  let accum = 0;
  let sinceEvent = 0;
  let held = 0;

  return {
    /** Feed a wheel event. */
    add(e) {
      accum += pixels(e);
      sinceEvent = 0;
    },

    /** Call once per fixed step: returns -1, 0 or +1. */
    take(dt) {
      if (accum === 0) { held = 0; return 0; }
      sinceEvent += dt;
      held += dt;
      if (Math.abs(accum) < threshold) {
        if (sinceEvent > STALE) { accum = 0; held = 0; }
        return 0;
      }
      if (sinceEvent < SETTLE && held < MAX_HOLD) return 0;
      const dir = Math.sign(accum);
      accum = 0; held = 0; sinceEvent = 0;
      return dir;
    },

    reset() { accum = 0; held = 0; sinceEvent = 0; },
  };
}
