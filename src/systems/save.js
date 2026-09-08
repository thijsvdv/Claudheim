const SAVE_KEY = 'ashwake.save.v1';
export const SEED_KEY = 'ashwake.seed';
const SAVE_VERSION = 1;
const AUTOSAVE_INTERVAL = 30; // seconds of in-game time

/**
 * Walks the system registry and persists whatever each system chooses to
 * expose via serialize()/hydrate(). Refuses a save from a different world
 * seed rather than hydrating mismatched state onto fresh terrain.
 */
export function createSave(game) {
  let lastAutosave = game.time.elapsed;

  function write() {
    try {
      const systems = {};
      for (const s of game.systems) {
        if (s.name && typeof s.serialize === 'function') systems[s.name] = s.serialize();
      }
      const blob = {
        version: SAVE_VERSION,
        seed: game.seed,
        time: {
          elapsed: game.time.elapsed,
          dayFraction: game.time.dayFraction,
          day: game.time.day,
        },
        systems,
        savedAt: Date.now(),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
      game.bus.emit('save:write', blob);
    } catch (err) {
      game.debug('save write failed', err);
    }
  }

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (err) {
      game.debug('save read failed', err);
      return false;
    }
    if (!raw) return false;

    let blob;
    try { blob = JSON.parse(raw); } catch (err) { game.debug('save parse failed', err); return false; }
    if (!blob || blob.version !== SAVE_VERSION) return false;
    // A save from another world seed describes terrain, resources and build
    // placements that don't exist here — safer to start fresh than hydrate
    // mismatched state onto a different island.
    if (blob.seed !== game.seed) return false;

    if (blob.time) {
      game.time.elapsed = blob.time.elapsed ?? game.time.elapsed;
      game.time.dayFraction = blob.time.dayFraction ?? game.time.dayFraction;
      game.time.day = blob.time.day ?? game.time.day;
      game.time.isNight = game.time.dayFraction < 0.2 || game.time.dayFraction > 0.8;
    }

    for (const s of game.systems) {
      const data = blob.systems?.[s.name];
      if (data === undefined || typeof s.hydrate !== 'function') continue;
      try { s.hydrate(data); } catch (err) { game.debug(`hydrate failed for "${s.name}"`, err); }
    }

    lastAutosave = game.time.elapsed;
    return true;
  }

  function clear() {
    try { localStorage.removeItem(SAVE_KEY); } catch (err) { game.debug('save clear failed', err); }
  }

  /** Forget the save *and* the island it belongs to — used by "new world". */
  function clearAll() {
    clear();
    try { localStorage.removeItem(SEED_KEY); } catch (err) { game.debug('seed clear failed', err); }
  }

  function savedAt() {
    try {
      const blob = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      return blob?.savedAt ?? null;
    } catch { return null; }
  }

  return {
    name: 'save',
    write,
    load,
    clear,
    clearAll,
    savedAt,

    fixedUpdate() {
      if (game.time.elapsed - lastAutosave >= AUTOSAVE_INTERVAL) {
        lastAutosave = game.time.elapsed;
        write();
      }
    },
  };
}
