/**
 * Keyboard + pointer-lock mouse. Actions are named so the UI and gameplay can
 * both ask "is `attack` down" without knowing about key codes.
 */
const DEFAULT_BINDS = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ControlLeft: 'crouch',
  KeyE: 'interact', KeyF: 'block', KeyQ: 'rune', KeyR: 'rotate',
  KeyI: 'inventory', KeyC: 'crafting', KeyV: 'vowtree', KeyB: 'build',
  KeyM: 'map', Tab: 'inventory', Escape: 'escape',
  Digit1: 'hotbar1', Digit2: 'hotbar2', Digit3: 'hotbar3', Digit4: 'hotbar4',
  Digit5: 'hotbar5', Digit6: 'hotbar6', Digit7: 'hotbar7', Digit8: 'hotbar8',
};

export function createInput(canvas, bus) {
  const down = new Set();
  const pressed = new Set();   // cleared every fixed step — edge triggers
  const released = new Set();
  let mouseDX = 0, mouseDY = 0, wheel = 0;
  let locked = false;
  let uiCaptured = false;      // true while a full-screen panel is open

  const mouseButtons = new Set();
  const mousePressed = new Set();

  function keyAction(code) { return DEFAULT_BINDS[code]; }

  addEventListener('keydown', (e) => {
    const a = keyAction(e.code);
    if (!a) return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!down.has(a)) pressed.add(a);
    down.add(a);
    bus.emit('input:action', a);
  });

  addEventListener('keyup', (e) => {
    const a = keyAction(e.code);
    if (!a) return;
    down.delete(a);
    released.add(a);
  });

  addEventListener('blur', () => { down.clear(); mouseButtons.clear(); });

  canvas.addEventListener('mousedown', (e) => {
    if (uiCaptured) return;
    if (!locked) { canvas.requestPointerLock?.(); return; }
    if (!mouseButtons.has(e.button)) mousePressed.add(e.button);
    mouseButtons.add(e.button);
  });
  addEventListener('mouseup', (e) => mouseButtons.delete(e.button));
  addEventListener('contextmenu', (e) => { if (locked) e.preventDefault(); });

  addEventListener('mousemove', (e) => {
    if (!locked) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  });

  addEventListener('wheel', (e) => { if (locked) wheel += Math.sign(e.deltaY); }, { passive: true });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    bus.emit('input:lock', locked);
    if (!locked) { down.clear(); mouseButtons.clear(); }
  });

  return {
    isDown: (a) => !uiCaptured && down.has(a),
    /** True only on the step the key went down. Always readable, even in UI. */
    wasPressed: (a) => pressed.has(a),
    wasReleased: (a) => released.has(a),
    mouse: (btn) => !uiCaptured && mouseButtons.has(btn),
    mouseWasPressed: (btn) => !uiCaptured && mousePressed.has(btn),
    get locked() { return locked; },
    setUiCaptured(v) { uiCaptured = v; if (v) { down.clear(); mouseButtons.clear(); } },
    get uiCaptured() { return uiCaptured; },
    requestLock: () => canvas.requestPointerLock?.(),
    exitLock: () => document.exitPointerLock?.(),
    /** Consume accumulated look delta. */
    takeLook() { const d = { x: mouseDX, y: mouseDY, wheel }; mouseDX = 0; mouseDY = 0; wheel = 0; return d; },
    endStep() { pressed.clear(); released.clear(); mousePressed.clear(); },
  };
}
