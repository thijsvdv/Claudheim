import { Vector3 } from 'three';
import { getItem } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';
import { getBiome } from '../data/biomes.js';
import { RECIPES } from '../data/recipes.js';
import { SKILLS, skillStaminaMult } from '../data/skills.js';
import { WARDENS } from '../data/enemies.js';
import { activeWarden } from '../entities/wardens.js';
import { paintIcon } from './itemicons.js';

/**
 * Always-on overlay. Pure DOM, built once in init(), then only text nodes and
 * classes are mutated afterward. Bars redraw every frame (they're cheap,
 * single CSS transforms); everything text-ish is throttled to ~20Hz so we
 * never touch layout more than we have to.
 */
const TEXT_HZ = 1 / 20;
const SVG_NS = 'http://www.w3.org/2000/svg';
// Geometry of the sky-clock orbit, mirrored in the SVG path above.
const CLOCK_CX = 84, CLOCK_CY = 31, CLOCK_RX = 66, CLOCK_RY = 21;
const INTERACT_RANGE = 3.2;
const TOAST_LIFE = 4200;
const BIOME_CARD_LIFE = 3600;

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// Most weapons/tools/shields/runes carry no flat `colour` (they're 3D props,
// not flat icons) — fall back to a kind-tinted swatch so hotbar/grid slots
// never render as a blank void.
const KIND_FALLBACK = { weapon: 0x8a8f96, tool: 0x8a8f96, shield: 0x7a6a4a, rune: 0x6b93b0, build: 0x9c8a6b };
const iconColour = (def) => def?.colour ?? KIND_FALLBACK[def?.kind] ?? 0x5a5f66;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const SAGA_LINES = [
  'The oath goes unspoken a while longer.',
  'You fall the way ash falls — without argument.',
  'The Ember holds. The rest can be mended.',
  'Not the ending. Only the cold part of the story.',
  'The island keeps what it is owed, and you are not paid yet.',
];

const CROSSHAIR = {
  idle: '<circle cx="12" cy="12" r="1.4"/>',
  ready: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6" stroke-width="1.4"/><circle cx="12" cy="12" r="1.2"/>',
  insufficient: '<path d="M12 4v5M12 15v5M4 12h5M15 12h5" stroke-width="1.1" opacity="0.5"/><circle cx="12" cy="12" r="1.2" opacity="0.6"/>',
  interact: '<path d="M12 2l7 4v6c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-4z" fill="none" stroke-width="1.4"/>',
};

export function createHud(game) {
  let root, refs;
  let textAcc = 0;
  let lastCrosshairState = null;
  const toastState = new Map();
  const offBus = [];

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function build() {
    root = el('div', 'hud');
    document.getElementById('ui-root')?.appendChild(root);

    const compass = el('div', 'hud-compass', root);
    const compassTrack = el('div', 'hud-compass-track', compass);
    const compassBiome = el('div', 'hud-compass-biome', compass);
    const biomeCard = el('div', 'hud-biome-card', root);
    const biomeCardName = el('div', 'hud-biome-card-name', biomeCard);
    const biomeCardSub = el('div', 'hud-biome-card-sub', biomeCard);
    biomeCardSub.textContent = 'a new ground underfoot';

    // Sky clock: the marker rides a full orbit — above the horizon line is
    // daylight, below it is night — so the shape of the day is readable at a
    // glance instead of needing a number.
    const clock = el('div', 'hud-clock', root);
    const clockSvg = document.createElementNS(SVG_NS, 'svg');
    clockSvg.setAttribute('viewBox', '0 0 168 62');
    clockSvg.setAttribute('class', 'hud-clock-svg');
    clockSvg.innerHTML = `
      <path class="hud-clock-arc night" d="M 18 31 A 66 21 0 0 0 150 31"/>
      <path class="hud-clock-arc day" d="M 18 31 A 66 21 0 0 1 150 31"/>
      <line class="hud-clock-horizon" x1="10" y1="31" x2="158" y2="31"/>
      <g class="hud-clock-marker">
        <circle class="hud-clock-glow" r="9"/>
        <circle class="hud-clock-body" r="4.4"/>
      </g>`;
    clock.appendChild(clockSvg);
    const clockMarker = clockSvg.querySelector('.hud-clock-marker');
    const clockLabel = el('div', 'hud-clock-label', clock);
    const dayCount = el('span', 'hud-clock-day', clockLabel);
    const clockTime = el('span', 'hud-clock-time', clockLabel);

    // Warden health, only on screen while one is alive.
    const boss = el('div', 'hud-boss hidden', root);
    const bossName = el('div', 'hud-boss-name', boss);
    const bossTrack = el('div', 'hud-boss-track', boss);
    const bossFill = el('div', 'hud-boss-fill', bossTrack);
    const bossHp = el('div', 'hud-boss-hp', boss);

    const vignette = el('div', 'hud-vignette', root);
    const desat = el('div', 'hud-desat', root);

    const crosshair = el('div', 'hud-crosshair', root);
    crosshair.innerHTML = `<svg viewBox="0 0 24 24"></svg>`;
    const interactPrompt = el('div', 'hud-interact', root);
    const interactKey = el('kbd', null, interactPrompt);
    interactKey.textContent = 'E';
    const interactLabel = el('span', null, interactPrompt);

    const vitals = el('div', 'hud-vitals', root);
    const hpBar = buildBar(vitals, 'hp');
    const stamBar = buildBar(vitals, 'stam');
    const eitrBar = buildBar(vitals, 'eitr');
    eitrBar.wrap.classList.add('hidden');
    const buffs = el('div', 'hud-buffs', vitals);

    const hotbar = el('div', 'hud-hotbar', root);
    const slots = [];
    for (let i = 0; i < 8; i++) {
      const slot = el('div', 'hud-slot', hotbar);
      const icon = el('div', 'hud-slot-icon', slot);
      const count = el('span', 'hud-slot-count', slot);
      const key = el('span', 'hud-slot-key', slot);
      key.textContent = String((i + 1) % 10);
      slots.push({ slot, icon, count });
    }

    // Build strip: what the hammer is holding, what it costs, why it won't go.
    const build = el('div', 'hud-build hidden', root);
    const buildName = el('div', 'hud-build-name', build);
    const buildCost = el('div', 'hud-build-cost', build);
    const buildWhy = el('div', 'hud-build-why', build);
    const buildHint = el('div', 'hud-build-hint', build);
    const buildRange = el('div', 'hud-build-range', build);
    buildHint.innerHTML =
      '<kbd>B</kbd> pieces <kbd>wheel</kbd> distance <kbd>shift+wheel</kbd> height '
      + '<kbd>R</kbd> rotate <kbd>LMB</kbd> place <kbd>RMB</kbd> remove';

    const toasts = el('div', 'hud-toasts', root);

    const death = el('div', 'hud-death hidden', root);
    const deathInner = el('div', 'hud-death-inner', death);
    const deathLine = el('p', 'hud-death-line', deathInner);
    const deathBtn = el('button', 'hud-death-btn', deathInner);
    deathBtn.type = 'button';
    deathBtn.textContent = 'Wake';
    deathBtn.addEventListener('click', () => {
      // player.js already re-forges the body at the bound Ember the instant
      // hp hits 0 — this button only needs to lift the veil off it.
      death.classList.add('hidden');
    });

    refs = {
      compassTrack, compassBiome, biomeCard, biomeCardName,
      clock, clockMarker, clockLabel, dayCount, clockTime,
      boss, bossName, bossFill, bossHp,
      vignette, desat, crosshair, interactPrompt, interactLabel,
      hpBar, stamBar, eitrBar, buffs, slots, toasts, death, deathLine,
      build, buildName, buildCost, buildWhy, buildRange,
    };

    // Compass ticks: one per 15deg across a wide strip, scrolled via transform.
    const TICKS = 24;
    for (let i = 0; i < TICKS; i++) {
      const deg = i * 15;
      const tick = el('div', 'hud-compass-tick', compassTrack);
      tick.style.setProperty('--deg', deg);
      const dirs = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      if (dirs[deg]) { tick.classList.add('major'); tick.textContent = dirs[deg]; }
      else if (deg % 45 === 0) { tick.classList.add('mid'); }
    }
  }

  function buildBar(parent, cls) {
    const wrap = el('div', `hud-bar hud-bar-${cls}`, parent);
    const fill = el('div', 'hud-bar-fill', wrap);
    const label = el('span', 'hud-bar-label', wrap);
    return { wrap, fill, label };
  }

  function setBar(bar, value, max) {
    const frac = max > 0 ? clamp01(value / max) : 0;
    bar.fill.style.transform = `scaleX(${frac})`;
    bar.label.textContent = `${Math.round(Math.max(0, value))} / ${Math.round(Math.max(0, max))}`;
  }

  // ---- toasts ----
  // `toastState` maps a coalescing key -> its live entry so repeats (e.g. the
  // same item gained twice in a row) update in place instead of stacking.
  // `activeToasts` is the flat list everything gets swept from, keyed or not.
  const activeToasts = [];
  function toast(key, text, cls) {
    const now = performance.now();
    let entry = key && toastState.get(key);
    if (entry) {
      entry.el.textContent = text;
      entry.el.classList.remove('bump');
      void entry.el.offsetWidth;
      entry.el.classList.add('bump');
      entry.expires = now + TOAST_LIFE;
      return entry;
    }
    const node = el('div', `hud-toast${cls ? ' ' + cls : ''}`, refs.toasts);
    node.textContent = text;
    entry = { el: node, expires: now + TOAST_LIFE, key, total: 0 };
    activeToasts.push(entry);
    if (key) toastState.set(key, entry);
    while (refs.toasts.childElementCount > 6) refs.toasts.firstElementChild?.remove();
    return entry;
  }

  function sweepToasts() {
    const now = performance.now();
    for (let i = activeToasts.length - 1; i >= 0; i--) {
      const entry = activeToasts[i];
      if (now < entry.expires) continue;
      entry.el.remove();
      if (entry.key) toastState.delete(entry.key);
      activeToasts.splice(i, 1);
    }
  }

  // ---- interaction target ----
  const fwd = new Vector3();
  const toNode = new Vector3();
  function findInteractTarget() {
    const near = game.world?.resources?.near;
    const pos = game.player?.position;
    if (!near || !pos) return null;
    let nodes;
    try { nodes = near.call(game.world.resources, pos, INTERACT_RANGE); } catch { return null; }
    if (!nodes || !nodes.length) return null;
    try { game.camera.getWorldDirection(fwd); } catch { fwd.set(0, 0, -1); }
    fwd.y = 0; if (fwd.lengthSq() > 0) fwd.normalize();
    let best = null, bestScore = -Infinity;
    for (const node of nodes) {
      if (!node?.position) continue;
      if (node.tier !== 0 || node.tool !== 'pick') continue; // needs a tool, not E
      toNode.copy(node.position).sub(pos);
      const dist = Math.hypot(toNode.x, toNode.z);
      let score;
      if (dist < 0.15) score = 999;
      else {
        toNode.y = 0; toNode.normalize();
        const dot = toNode.x * fwd.x + toNode.z * fwd.z;
        if (dot < 0.35) continue;
        score = dot - dist * 0.08;
      }
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  function equippedWeapon() {
    const item = game.inventory?.equipped;
    return (item?.weapon && getWeapon(item.weapon)) || getWeapon('fists');
  }

  // Mirrors combat.js's light-swing cost (minus the per-move multiplier,
  // which the crosshair can't know ahead of the swing) closely enough to be
  // a useful "can I afford to swing" hint.
  function attackStaminaCost(weapon) {
    const level = game.progression?.level?.(weapon.skill) ?? 0;
    const mult = skillStaminaMult(level) * (game.progression?.effects?.staminaCostMult ?? 1);
    return weapon.stamina * mult;
  }

  // ---- event wiring ----
  function wire() {
    const bus = game.bus;
    offBus.push(bus.on('item:gained', (p) => {
      const id = p?.id ?? p?.itemId ?? (typeof p === 'string' ? p : null);
      if (!id) return;
      const count = p?.count ?? p?.amount ?? 1;
      const def = getItem(id);
      const key = `item:${id}`;
      const total = (toastState.get(key)?.total ?? 0) + count;
      const name = def?.name ?? titleCase(id);
      const entry = toast(key, total > 1 ? `${name} x${total}` : name, null);
      entry.total = total;
    }));
    // Generic one-off message any system can raise.
    offBus.push(bus.on('notice', (p) => {
      const text = typeof p === 'string' ? p : p?.text;
      if (text) toast(null, text, null);
    }));
    offBus.push(bus.on('craft:completed', (p) => {
      const id = typeof p === 'string' ? p : p?.id;
      const recipe = RECIPES.find((r) => r.id === id) ?? (p?.out ? p : null);
      const outId = recipe?.out ? Object.keys(recipe.out)[0] : id;
      const def = getItem(outId);
      toast(null, `Crafted ${def?.name ?? titleCase(outId ?? 'something')}`, 'hud-toast-craft');
    }));
    offBus.push(bus.on('player:levelup', (p) => {
      const skillId = p?.skill ?? p?.id;
      const level = p?.level ?? p?.to ?? '';
      const name = SKILLS[skillId]?.name ?? titleCase(skillId ?? '');
      toast(null, `${name} ${level}`.trim(), 'hud-toast-level');
    }));
    offBus.push(bus.on('warden:defeated', (p) => {
      const id = typeof p === 'string' ? p : p?.id;
      const name = p?.name ?? WARDENS[id]?.name ?? 'A Warden';
      toast(null, `${name} has fallen.`, 'hud-toast-warden');
    }));
    offBus.push(bus.on('player:damaged', () => {
      refs.vignette.classList.remove('pulse');
      void refs.vignette.offsetWidth;
      refs.vignette.classList.add('pulse');
    }));
    offBus.push(bus.on('player:died', () => {
      refs.deathLine.textContent = SAGA_LINES[Math.floor(Math.random() * SAGA_LINES.length)];
      refs.death.classList.remove('hidden');
    }));
    offBus.push(bus.on('biome:discovered', (p) => {
      const id = p?.id ?? p?.biome ?? (typeof p === 'string' ? p : null);
      if (!id) return;
      game._uiDiscoveredBiomes ??= new Set();
      game._uiDiscoveredBiomes.add(id);
      const biome = getBiome(id);
      refs.biomeCardName.textContent = biome.name;
      refs.biomeCard.classList.remove('show');
      void refs.biomeCard.offsetWidth;
      refs.biomeCard.classList.add('show');
      clearTimeout(refs.biomeCard._t);
      refs.biomeCard._t = setTimeout(() => refs.biomeCard.classList.remove('show'), BIOME_CARD_LIFE);
    }));
    offBus.push(bus.on('build:placed', (p) => {
      // `defId` is the piece definition ('hearth', 'wood_wall', ...); `id` is
      // the placed instance's own id, per systems/building.js.
      const defId = p?.defId ?? p?.id ?? p?.piece ?? p?.type;
      if (defId !== 'hearth') return;
      const position = p?.position;
      if (!position) return;
      game._uiHearths ??= [];
      game._uiHearths.push({ x: position.x, z: position.z });
    }));
  }

  function updateBars() {
    const stats = game.player?.stats;
    setBar(refs.hpBar, stats?.hp ?? 0, stats?.maxHp ?? 0);
    setBar(refs.stamBar, stats?.stam ?? 0, stats?.maxStam ?? 0);
    const eitrMax = game.progression?.effects?.eitrMax ?? stats?.maxEitr ?? 0;
    if (eitrMax > 0) {
      refs.eitrBar.wrap.classList.remove('hidden');
      setBar(refs.eitrBar, stats?.eitr ?? 0, eitrMax);
    } else if (!refs.eitrBar.wrap.classList.contains('hidden')) {
      refs.eitrBar.wrap.classList.add('hidden');
    }

    const frac = stats?.maxHp > 0 ? clamp01((stats.hp ?? 0) / stats.maxHp) : 1;
    const desatTarget = frac < 0.3 ? (0.3 - frac) / 0.3 : 0;
    refs.desat.style.opacity = String(clamp01(desatTarget) * 0.75);
  }

  function updateCrosshair(target) {
    let state = 'idle';
    if (target) state = 'interact';
    else {
      const weapon = equippedWeapon();
      const stam = game.player?.stats?.stam ?? 0;
      state = stam >= attackStaminaCost(weapon) ? 'ready' : 'insufficient';
    }
    if (state !== lastCrosshairState) {
      lastCrosshairState = state;
      refs.crosshair.className = `hud-crosshair state-${state}`;
      const svg = refs.crosshair.querySelector('svg');
      if (svg) svg.innerHTML = CROSSHAIR[state] ?? CROSSHAIR.idle;
    }
  }

  function updateInteractPrompt(target) {
    if (!target) { refs.interactPrompt.classList.remove('show'); return; }
    refs.interactLabel.textContent = `Harvest ${titleCase(target.kind ?? 'Resource')}`;
    refs.interactPrompt.classList.add('show');
  }

  function updateCompass() {
    try { game.camera.getWorldDirection(fwd); } catch { return; }
    const heading = (Math.atan2(fwd.x, fwd.z) * 180 / Math.PI + 360) % 360;
    refs.compassTrack.style.transform = `translateX(${-heading * (100 / 15)}%)`;
    const pos = game.player?.position;
    const biomeId = pos && game.world?.biomeAt ? game.world.biomeAt(pos.x, pos.z) : null;
    refs.compassBiome.textContent = biomeId ? getBiome(biomeId).name : '';
  }

  function updateDay() {
    const t = game.time;
    if (!t) return;
    const f = t.dayFraction ?? 0;

    // Orbit: noon at the top, midnight at the bottom, dawn on the left.
    const x = CLOCK_CX - CLOCK_RX * Math.sin(f * Math.PI * 2);
    const y = CLOCK_CY + CLOCK_RY * Math.cos(f * Math.PI * 2);
    refs.clockMarker.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);

    const night = !!t.isNight;
    refs.clock.classList.toggle('is-night', night);
    refs.dayCount.textContent = `Day ${t.day}`;

    const mins = Math.floor(f * 1440);
    refs.clockTime.textContent =
      `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  let buildPieceId = null;
  let buildCostEls = null;

  function updateBuild() {
    const building = game.building;
    const piece = building?.buildMode ? building.piece : null;
    if (!piece) {
      if (!refs.build.classList.contains('hidden')) {
        refs.build.classList.add('hidden');
        buildPieceId = null;
      }
      return;
    }
    refs.build.classList.remove('hidden');

    if (piece.id !== buildPieceId) {
      buildPieceId = piece.id;
      refs.buildName.textContent = piece.name;
      refs.buildCost.innerHTML = '';
      buildCostEls = new Map();
      for (const id of Object.keys(piece.cost ?? {})) {
        buildCostEls.set(id, el('span', 'hud-build-ing', refs.buildCost));
      }
    }

    for (const [id, need] of Object.entries(piece.cost ?? {})) {
      const span = buildCostEls.get(id);
      if (!span) continue;
      const have = game.inventory?.count?.(id) ?? 0;
      span.textContent = `${getItem(id)?.name ?? titleCase(id)} ${have}/${need}`;
      span.classList.toggle('have', have >= need);
      span.classList.toggle('need', have < need);
    }

    const dist = building.buildDistance ?? 0;
    const height = building.buildHeight ?? 0;
    refs.buildRange.textContent =
      `${dist.toFixed(1)} m out · ${height >= 0 ? '+' : ''}${height.toFixed(2)} m up`;

    const ok = building.ghostValid;
    refs.build.classList.toggle('invalid', !ok);
    refs.buildWhy.textContent = ok ? '' : (building.ghostReason ?? '');
  }

  function updateBoss() {
    let boss = null;
    try { boss = activeWarden(); } catch { boss = null; }
    if (!boss) {
      if (!refs.boss.classList.contains('hidden')) refs.boss.classList.add('hidden');
      return;
    }
    refs.boss.classList.remove('hidden');
    const name = boss.def?.name ?? 'Warden';
    if (refs.bossName.textContent !== name) refs.bossName.textContent = name;
    const max = boss.maxHp || 1;
    refs.bossFill.style.transform = `scaleX(${clamp01((boss.hp ?? 0) / max)})`;
    refs.bossHp.textContent = `${Math.max(0, Math.ceil(boss.hp ?? 0))} / ${Math.round(max)}`;
  }

  function updateHotbar() {
    const slots = game.inventory?.slots;
    const selected = game.inventory?.selected ?? 0;
    for (let i = 0; i < 8; i++) {
      const ref = refs.slots[i];
      const stack = slots?.[i];
      const def = stack?.id ? getItem(stack.id) : null;
      paintIcon(ref.icon, def?.id ?? null, def ? hex(iconColour(def)) : 'transparent');
      ref.icon.textContent = '';
      ref.count.textContent = stack?.count > 1 ? String(stack.count) : '';
      ref.slot.title = def?.name ?? '';
      ref.slot.classList.toggle('empty', !stack);
      ref.slot.classList.toggle('selected', i === selected);
    }
  }

  function updateBuffs() {
    const buffs = game.survival?.buffs;
    const list = Array.isArray(buffs) ? buffs : buffs ? Object.values(buffs) : [];
    const host = refs.buffs;
    while (host.children.length > list.length) host.lastElementChild.remove();
    list.forEach((b, i) => {
      let node = host.children[i];
      if (!node) node = el('div', 'hud-buff', host);
      const duration = b.duration || 1;
      const remaining = b.remaining ?? b.time ?? 0;
      const frac = clamp01(remaining / duration);
      node.style.setProperty('--frac', frac.toFixed(3));
      node.style.setProperty('--tint', hex(b.icon ?? 0x6f7a52));
      node.title = b.name ?? b.id ?? '';
      node.dataset.icon = (b.name ?? b.id ?? '?').slice(0, 1).toUpperCase();
      node.style.setProperty('--letter', `"${node.dataset.icon}"`);
    });
  }

  return {
    name: 'hud',
    init(game) {
      try { build(); wire(); } catch (err) { game.debug?.('hud build failed', err); }
    },
    update(dt, game) {
      if (!refs) return;
      try { updateBars(); } catch (err) { game.debug?.('hud bars failed', err); }

      const target = findInteractTarget();
      updateCrosshair(target);

      textAcc += dt;
      if (textAcc < TEXT_HZ) return;
      textAcc = 0;
      try {
        updateInteractPrompt(target);
        updateCompass();
        updateDay();
        updateBoss();
        updateBuild();
        updateHotbar();
        updateBuffs();
        sweepToasts();
      } catch (err) { game.debug?.('hud text update failed', err); }
    },
    dispose() {
      for (const off of offBus) off();
      root?.remove();
    },
  };
}
