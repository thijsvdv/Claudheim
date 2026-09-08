import { Game } from './core/game.js';
import { createWorld } from './world/world.js';
import { createSky } from './world/sky.js';
import { createInventory } from './systems/inventory.js';
import { createProgression } from './systems/progression.js';
import { createPlayer } from './entities/player.js';
import { createCameraRig } from './entities/camera.js';
import { createCombat } from './systems/combat.js';
import { createSurvival } from './systems/survival.js';
import { createSpawner } from './entities/spawner.js';
import { createCrafting } from './systems/crafting.js';
import { createBuilding } from './systems/building.js';
import { createAudio } from './systems/audio.js';
import { createHud } from './ui/hud.js';
import { createPanels } from './ui/panels.js';
import { createSave, SEED_KEY } from './systems/save.js';
import { loadSettings } from './core/settings.js';

const boot = document.getElementById('boot');
const status = document.getElementById('boot-status');
const playBtn = document.getElementById('boot-play');
const canvas = document.getElementById('viewport');

/**
 * The seed *is* the world: a save only loads back onto the island it was made
 * on, so the seed has to survive a reload. `?seed=` still wins, and "new world"
 * in the menu clears the stored one.
 */
function resolveSeed() {
  const raw = new URLSearchParams(location.search).get('seed');
  let seed;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) seed = n | 0;
    else {
      // Allow a word seed, e.g. ?seed=vardholm
      let h = 2166136261;
      for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
      seed = h >>> 1;
    }
  } else {
    let stored = null;
    try { stored = localStorage.getItem(SEED_KEY); } catch { stored = null; }
    const n = stored === null ? NaN : Number(stored);
    seed = Number.isFinite(n) ? n | 0 : Math.floor(Math.random() * 1e9);
  }
  try { localStorage.setItem(SEED_KEY, String(seed)); } catch { /* private mode */ }
  return seed;
}

async function boot_() {
  loadSettings();
  const seed = resolveSeed();
  const debug = new URLSearchParams(location.search).has('debug');
  const game = new Game(canvas, { seed, debug });
  window.__ashwake = game; // console access for debugging

  const factories = [
    ['world', createWorld], ['sky', createSky],
    ['inventory', createInventory], ['progression', createProgression],
    ['player', createPlayer], ['camera', createCameraRig],
    ['combat', createCombat], ['survival', createSurvival],
    ['spawner', createSpawner], ['crafting', createCrafting],
    ['building', createBuilding], ['audio', createAudio],
    ['hud', createHud], ['panels', createPanels], ['save', createSave],
  ];

  for (const [label, make] of factories) {
    status.textContent = `forging ${label}…`;
    // Yield so the boot text actually paints between heavy constructors.
    await new Promise((r) => requestAnimationFrame(r));
    try {
      const sys = make(game);
      if (sys) game.register(sys);
    } catch (err) {
      console.error(`[ashwake] system "${label}" failed to construct`, err);
    }
  }

  status.textContent = 'waking…';
  await new Promise((r) => requestAnimationFrame(r));
  game.init();

  // Resume a save if one exists; otherwise this is a fresh shore.
  const resumed = game.get('save')?.load?.() ?? false;
  game.bus.emit(resumed ? 'save:load' : 'player:spawned', game);

  status.hidden = true;
  playBtn.hidden = false;
  playBtn.textContent = resumed ? 'Return' : 'Wake';
  playBtn.focus();

  playBtn.addEventListener('click', () => {
    boot.classList.add('gone');
    setTimeout(() => { boot.hidden = true; }, 900);
    game.input.requestLock();
    game.start();
  }, { once: true });

  // Re-showing the boot veil on unlock would fight the UI panels, so the
  // pointer-lock loss just pauses input, handled inside the input system.
  // beforeunload alone is unreliable (mobile, tab discard), so flush on every
  // way out of the page.
  const flush = () => { try { game.get('save')?.write?.(); } catch { /* nothing to do */ } };
  addEventListener('beforeunload', flush);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

boot_().catch((err) => {
  console.error(err);
  status.textContent = 'the island would not form: ' + err.message;
});
