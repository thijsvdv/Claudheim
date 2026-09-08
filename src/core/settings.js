/**
 * Player-facing options, persisted per browser. Read the live object wherever
 * a setting is used — never cache a copy, or a toggle mid-session won't take.
 */

const KEY = 'ashwake.settings';

const DEFAULTS = {
  /** Playtest mode: 10x sprint speed and 10x damage from your own attacks. */
  debugMode: false,
};

export const settings = { ...DEFAULTS };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return settings;
    const blob = JSON.parse(raw);
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof blob?.[key] === typeof DEFAULTS[key]) settings[key] = blob[key];
    }
  } catch { /* private mode, corrupt json: defaults stand */ }
  return settings;
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return settings[key];
  settings[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* nothing to do */ }
  return settings[key];
}
