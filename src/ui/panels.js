import { Vector3 } from 'three';
import { getItem } from '../data/items.js';
import { getWeapon } from '../data/weapons.js';
import { RECIPES } from '../data/recipes.js';
import { SKILLS, xpForLevel } from '../data/skills.js';
import { getBiome } from '../data/biomes.js';
import { renderVowTree } from './vowtree.js';
import { paintIcon } from './itemicons.js';
import { settings, setSetting } from '../core/settings.js';

/**
 * Full-screen modal panels toggled by input actions. Only one is ever open.
 * Opening captures input (`setUiCaptured` + `exitLock`) so the player stops
 * moving behind the UI; closing restores both. DOM for every panel is built
 * once in init() — refresh() calls only touch text/classes on existing nodes.
 */
const REFRESH_HZ = 1 / 12;
const SLOT_COUNT = 32;
const HOTBAR_SIZE = 8;  // the first row of the grid is the hotbar, keys 1-8
const MAP_SPAN = 220;   // metres of world shown across the minimap
const MAP_RES = 72;     // coarse sample grid resolution
const MAP_RESAMPLE_DIST = 24; // metres the player must move before resampling
const MAP_PIXELS = 512;

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// See hud.js — same fallback so weapons/tools/shields/runes (which carry no
// flat `colour`) still render a tinted swatch instead of an empty square.
const KIND_FALLBACK = { weapon: 0x8a8f96, tool: 0x8a8f96, shield: 0x7a6a4a, rune: 0x6b93b0, build: 0x9c8a6b };
const iconColour = (def) => def?.colour ?? KIND_FALLBACK[def?.kind] ?? 0x5a5f66;


function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function normalizeRecipe(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return RECIPES.find((r) => r.id === entry) ?? null;
  if (entry.cost && entry.out) return entry;
  if (entry.id) return RECIPES.find((r) => r.id === entry.id) ?? null;
  return null;
}

function shade(colourInt, amount) {
  if (colourInt == null) return '#20242a';
  const r = (colourInt >> 16) & 255, g = (colourInt >> 8) & 255, b = colourInt & 255;
  const adj = (c) => Math.max(0, Math.min(255, Math.round(c + amount * 255)));
  return `rgb(${adj(r)},${adj(g)},${adj(b)})`;
}

function fillTooltip(tooltip, stack) {
  const def = getItem(stack.id);
  if (!def) { tooltip.innerHTML = ''; return; }
  let extra = '';
  if (def.food) {
    extra += `<div class="tt-row">Heals ${def.food.hp} hp / ${def.food.stam} stam</div>`;
    extra += `<div class="tt-row">Lasts ${Math.round(def.food.duration / 60)}m</div>`;
  }
  if (def.weapon) {
    const w = getWeapon(def.weapon);
    const dmg = Object.entries(w.damage || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    extra += `<div class="tt-row">${dmg}</div><div class="tt-row">Stagger ${w.stagger} &middot; Stamina ${w.stamina}</div>`;
  }
  if (def.block) extra += `<div class="tt-row">Block armour ${def.block.armour}</div>`;
  if (def.rune) extra += `<div class="tt-row">${def.rune.eitr} Eitr &middot; ${def.rune.damage} ${def.rune.type}</div>`;
  tooltip.innerHTML = `<div class="tt-name">${def.name}</div>` +
    `<div class="tt-kind">${def.kind}${stack.count > 1 ? ` &times; ${stack.count}` : ''} &middot; ${def.weight}kg</div>${extra}`;
}

export function createPanels(game) {
  let root;
  const panels = {};
  let openPanel = null;
  let acc = 0;

  function openPanelByName(name) {
    if (!panels[name]) return;
    if (openPanel === name) { closeAll(); return; }
    const wasClosed = openPanel === null;
    if (openPanel) panels[openPanel].el.classList.remove('open');
    openPanel = name;
    panels[name].el.classList.add('open');
    root.classList.add('open');
    if (wasClosed) { game.input?.setUiCaptured?.(true); game.input?.exitLock?.(); }
    // The menu is a real pause; the other panels leave the world running.
    game.paused = name === 'menu';
    try { panels[name].onOpen?.(); } catch (err) { game.debug?.(`panel ${name} open failed`, err); }
    try { panels[name].refresh(true); } catch (err) { game.debug?.(`panel ${name} refresh failed`, err); }
  }

  // The DOM Escape handler below and the input system both see the same key
  // press; without this the menu would close and immediately reopen.
  let escapeGuard = 0;

  function closeAll() {
    if (!openPanel) return;
    game.paused = false;
    panels[openPanel].el.classList.remove('open');
    openPanel = null;
    root.classList.remove('open');
    game.input?.setUiCaptured?.(false);
    game.input?.requestLock?.();
  }

  // ---------------------------------------------------------------- inventory
  function buildInventoryPanel() {
    const elp = el('div', 'panel inventory-panel');
    const header = el('div', 'panel-header', elp);
    header.innerHTML = '<h2>Satchel</h2><p class="panel-hint">top row is the hotbar &mdash; drag an item onto 1-8 to bind it &middot; right-click food to eat</p>';
    const body = el('div', 'panel-body inventory-body', elp);

    // Per systems/inventory.js there is no separate "weapon slot" — the active
    // weapon is just whatever sits in the selected hotbar slot (`inv.equipped`).
    // The weapon box below is a read-only mirror of that; dropping a hotbar
    // item onto it selects that hotbar slot. Shield/rune are real dedicated
    // holders, equipped via `equipShield`/`equipRune`.
    const equipWrap = el('div', 'equip-slots', body);
    const equipSlots = {};
    for (const type of ['weapon', 'shield', 'rune']) {
      const s = el('div', 'equip-slot', equipWrap);
      s.dataset.type = type;
      const icon = el('div', 'equip-slot-icon', s);
      const label = el('div', 'equip-slot-label', s);
      label.textContent = type;
      equipSlots[type] = { s, icon };
      s.addEventListener('dragover', (e) => { e.preventDefault(); s.classList.add('drop-hover'); });
      s.addEventListener('dragleave', () => s.classList.remove('drop-hover'));
      s.addEventListener('drop', (e) => {
        e.preventDefault();
        s.classList.remove('drop-hover');
        const from = Number(e.dataTransfer.getData('text/slot-index'));
        const stack = game.inventory?.slots?.[from];
        if (!stack) return;
        try {
          if (type === 'weapon') {
            if (from >= 0 && from < 8) game.inventory?.selectHotbar?.(from);
          } else if (type === 'shield') {
            game.inventory?.equipShield?.(stack.id);
          } else {
            game.inventory?.equipRune?.(stack.id);
          }
        } catch (err) { game.debug?.('equip failed', err); }
      });
      if (type !== 'weapon') {
        s.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          try {
            if (type === 'shield') game.inventory?.equipShield?.(null);
            else game.inventory?.equipRune?.(null);
          } catch (err) { game.debug?.('unequip failed', err); }
        });
      }
    }

    const grid = el('div', 'inv-grid', body);
    const slotEls = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = el('div', 'inv-slot', grid);
      s.dataset.index = String(i);
      s.draggable = true;
      if (i < HOTBAR_SIZE) {
        s.classList.add('is-hotbar');
        const key = el('span', 'inv-slot-key', s);
        key.textContent = String(i + 1);
      }
      const icon = el('div', 'inv-slot-icon', s);
      const count = el('span', 'inv-slot-count', s);
      slotEls.push({ s, icon, count });
    }

    const weightWrap = el('div', 'carry-weight', body);
    const weightFill = el('div', 'carry-weight-fill', weightWrap);
    const weightLabel = el('span', 'carry-weight-label', weightWrap);

    const tooltip = el('div', 'item-tooltip hidden', elp);

    grid.addEventListener('dragstart', (e) => {
      const target = e.target.closest('.inv-slot');
      if (!target || !game.inventory?.slots?.[Number(target.dataset.index)]) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/slot-index', target.dataset.index);
      e.dataTransfer.effectAllowed = 'move';
    });
    grid.addEventListener('dragover', (e) => { if (e.target.closest('.inv-slot')) e.preventDefault(); });
    grid.addEventListener('drop', (e) => {
      const target = e.target.closest('.inv-slot');
      if (!target) return;
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/slot-index'));
      const to = Number(target.dataset.index);
      const slots = game.inventory?.slots;
      if (!slots || Number.isNaN(from) || Number.isNaN(to) || from === to) return;
      // Reorder by swapping the documented live slots array in place.
      const tmp = slots[to]; slots[to] = slots[from]; slots[from] = tmp;
      refresh(true);
    });
    grid.addEventListener('contextmenu', (e) => {
      const target = e.target.closest('.inv-slot');
      if (!target) return;
      e.preventDefault();
      const stack = game.inventory?.slots?.[Number(target.dataset.index)];
      const def = stack && getItem(stack.id);
      if (def?.kind === 'food') {
        // survival.eat() only manages the buff timer; it doesn't touch the
        // inventory, so consuming the item is on us.
        try {
          if (game.survival?.eat?.(stack.id)) game.inventory?.remove?.(stack.id, 1);
        } catch (err) { game.debug?.('eat failed', err); }
      }
    });
    grid.addEventListener('mousemove', (e) => {
      const target = e.target.closest('.inv-slot');
      const stack = target && game.inventory?.slots?.[Number(target.dataset.index)];
      if (!stack) { tooltip.classList.add('hidden'); return; }
      fillTooltip(tooltip, stack);
      tooltip.classList.remove('hidden');
      tooltip.style.left = `${e.clientX + 16}px`;
      tooltip.style.top = `${e.clientY + 16}px`;
    });
    grid.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));

    function refresh() {
      const slots = game.inventory?.slots;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const { s, icon, count } = slotEls[i];
        const stack = slots?.[i];
        const def = stack?.id ? getItem(stack.id) : null;
        paintIcon(icon, def?.id ?? null, def ? hex(iconColour(def)) : 'transparent');
        count.textContent = stack?.count > 1 ? String(stack.count) : '';
        s.classList.toggle('empty', !stack);
        s.title = def?.name ?? '';
      }
      const equipment = game.inventory?.equipment ?? {};
      const mainEquipped = game.inventory?.equipped; // weapon = selected hotbar item
      for (const type of ['weapon', 'shield', 'rune']) {
        const id = type === 'weapon' ? mainEquipped?.id : equipment[type];
        const def = id ? getItem(id) : null;
        paintIcon(equipSlots[type].icon, def?.id ?? null, def ? hex(iconColour(def)) : 'transparent');
        equipSlots[type].s.title = def?.name ?? '(empty)';
      }
      const weight = game.inventory?.weight ?? 0;
      const maxWeight = game.inventory?.capacity ?? 100;
      weightFill.style.transform = `scaleX(${maxWeight > 0 ? Math.min(1, weight / maxWeight) : 0})`;
      weightFill.classList.toggle('over', game.inventory?.overweight ?? weight > maxWeight);
      weightLabel.textContent = `${weight.toFixed(1)} / ${maxWeight.toFixed(0)} kg`;
    }

    return { el: elp, refresh };
  }

  // ----------------------------------------------------------------- crafting
  function buildCraftingPanel() {
    const elp = el('div', 'panel crafting-panel');
    const header = el('div', 'panel-header', elp);
    header.innerHTML = '<h2>Craft</h2>';
    const body = el('div', 'panel-body crafting-body', elp);
    const rows = new Map();
    const sectionHints = new Map();
    let lastIds = '';

    function stationLabel(station) { return station ? titleCase(station) : 'Anywhere'; }

    function rebuild(list) {
      body.innerHTML = '';
      rows.clear();
      const groups = new Map();
      for (const recipe of list) {
        const key = recipe.station ?? null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(recipe);
      }
      const order = [null, 'workbench', 'forge', 'campfire'];
      const keys = [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k))];
      for (const station of keys) {
        const section = el('div', 'craft-section', body);
        const h = el('h3', null, section);
        h.textContent = stationLabel(station);
        if (station) {
          const hint = el('span', 'craft-station-hint', h);
          sectionHints.set(station, hint);
        }
        for (const recipe of groups.get(station)) {
          const row = el('div', 'craft-row', section);
          const outId = Object.keys(recipe.out)[0];
          const outDef = getItem(outId);
          const name = el('div', 'craft-name', row);
          name.textContent = `${outDef?.name ?? titleCase(outId)}${recipe.out[outId] > 1 ? ` x${recipe.out[outId]}` : ''}`;
          const ingWrap = el('div', 'craft-ingredients', row);
          const ingEls = {};
          for (const id of Object.keys(recipe.cost)) ingEls[id] = el('span', 'craft-ing', ingWrap);
          const btn = el('button', 'craft-btn', row);
          btn.type = 'button';
          btn.textContent = 'Craft';
          btn.addEventListener('click', () => {
            try { game.crafting?.craft?.(recipe.id); } catch (err) { game.debug?.('craft failed', err); }
          });
          rows.set(recipe.id, { recipe, ingEls, btn, row });
        }
      }
    }

    function refresh(force) {
      // Every recipe is listed, always — otherwise there's no way to learn that
      // a forge exists. What a station gates is whether the row is *usable*.
      const list = RECIPES.map(normalizeRecipe).filter(Boolean);
      let unlocked;
      try {
        unlocked = new Set((game.crafting?.available?.() ?? list).map((r) => normalizeRecipe(r)?.id));
      } catch { unlocked = new Set(list.map((r) => r.id)); }

      const ids = list.map((r) => r.id).join(',');
      if (force || ids !== lastIds) { rebuild(list); lastIds = ids; }

      for (const [station, hint] of sectionHints) {
        const near = list.some((r) => r.station === station && unlocked.has(r.id));
        hint.textContent = near ? '' : `— build a ${station} and stand near it`;
      }

      for (const { recipe, ingEls, btn, row } of rows.values()) {
        const usable = unlocked.has(recipe.id);
        row.classList.toggle('locked', !usable);
        let craftable = usable;
        for (const [id, need] of Object.entries(recipe.cost)) {
          const have = game.inventory?.count?.(id) ?? 0;
          const span = ingEls[id];
          if (span) {
            span.textContent = `${getItem(id)?.name ?? titleCase(id)} ${have}/${need}`;
            span.classList.toggle('have', have >= need);
            span.classList.toggle('need', have < need);
          }
          if (have < need) craftable = false;
        }
        btn.disabled = !craftable;
      }
    }

    return { el: elp, refresh };
  }

  // ------------------------------------------------------------------ vowtree
  function buildVowtreePanel() {
    const elp = el('div', 'panel vowtree-panel');
    const layout = el('div', 'vowtree-layout', elp);
    const treeHost = el('div', 'vowtree-host', layout);
    const skillsHost = el('div', 'skills-host', layout);
    el('h3', null, skillsHost).textContent = 'Proficiencies';
    const skillsList = el('div', 'skills-list', skillsHost);
    const skillRows = new Map();
    for (const skill of Object.values(SKILLS)) {
      const row = el('div', 'skill-row', skillsList);
      row.dataset.group = skill.group;
      el('span', 'skill-name', row).textContent = skill.name;
      const bar = el('div', 'skill-bar', row);
      const fill = el('div', 'skill-bar-fill', bar);
      const level = el('span', 'skill-level', row);
      skillRows.set(skill.id, { fill, level });
    }

    function refresh() {
      try { renderVowTree(game, treeHost); } catch (err) { game.debug?.('vowtree render failed', err); }
      for (const [id, refs] of skillRows) {
        let lvl = 0;
        try { lvl = game.progression?.level?.(id) ?? 0; } catch { lvl = 0; }
        let frac = lvl / 100;
        try {
          // Not part of the documented contract — used only if a fine-grained
          // xp getter happens to exist; otherwise level/100 is the fallback.
          const xp = game.progression?.xp?.(id);
          if (typeof xp === 'number') {
            const cur = xpForLevel(lvl), next = xpForLevel(lvl + 1);
            frac = next > cur ? Math.min(1, (xp - cur) / (next - cur)) : 1;
          }
        } catch { /* fallback stands */ }
        refs.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
        refs.level.textContent = String(lvl);
      }
    }

    return { el: elp, refresh };
  }

  // ---------------------------------------------------------------------- map
  function buildMapPanel() {
    const elp = el('div', 'panel map-panel');
    el('div', 'panel-header', elp).innerHTML = '<h2>The Island</h2>';
    const body = el('div', 'panel-body map-body', elp);
    const wrap = el('div', 'map-canvas-wrap', body);
    const bg = el('canvas', 'map-canvas map-bg', wrap);
    const fg = el('canvas', 'map-canvas map-fg', wrap);
    bg.width = bg.height = MAP_PIXELS;
    fg.width = fg.height = MAP_PIXELS;
    const bctx = bg.getContext('2d');
    const fctx = fg.getContext('2d');
    const cache = { cx: null, cz: null };
    const fwd = new Vector3();

    function resample() {
      const pos = game.player?.position ?? { x: 0, z: 0 };
      cache.cx = pos.x; cache.cz = pos.z;
      if (!game.world?.biomeAt) { bctx.fillStyle = '#1a1c1e'; bctx.fillRect(0, 0, MAP_PIXELS, MAP_PIXELS); return; }
      const cell = MAP_PIXELS / MAP_RES;
      const heights = game.world.heightAt ? new Float32Array(MAP_RES * MAP_RES) : null;
      let hMin = Infinity, hMax = -Infinity;
      if (heights) {
        for (let gy = 0; gy < MAP_RES; gy++) {
          for (let gx = 0; gx < MAP_RES; gx++) {
            const wx = cache.cx + (gx / (MAP_RES - 1) - 0.5) * MAP_SPAN;
            const wz = cache.cz + (gy / (MAP_RES - 1) - 0.5) * MAP_SPAN;
            let hgt = 0;
            try { hgt = game.world.heightAt(wx, wz) ?? 0; } catch { hgt = 0; }
            heights[gy * MAP_RES + gx] = hgt;
            if (hgt < hMin) hMin = hgt;
            if (hgt > hMax) hMax = hgt;
          }
        }
      }
      const range = Math.max(1, hMax - hMin);
      for (let gy = 0; gy < MAP_RES; gy++) {
        for (let gx = 0; gx < MAP_RES; gx++) {
          const wx = cache.cx + (gx / (MAP_RES - 1) - 0.5) * MAP_SPAN;
          const wz = cache.cz + (gy / (MAP_RES - 1) - 0.5) * MAP_SPAN;
          let biomeId = 'fjaldmark';
          try { biomeId = game.world.biomeAt(wx, wz) ?? biomeId; } catch { /* keep default */ }
          const biome = getBiome(biomeId);
          const lightness = heights ? ((heights[gy * MAP_RES + gx] - hMin) / range - 0.5) * 0.3 : 0;
          bctx.fillStyle = shade(biome.ground, lightness);
          bctx.fillRect(gx * cell, gy * cell, cell + 1, cell + 1);
        }
      }
    }

    function toCanvas(x, z) {
      return [
        MAP_PIXELS / 2 + ((x - (cache.cx ?? 0)) / MAP_SPAN) * MAP_PIXELS,
        MAP_PIXELS / 2 + ((z - (cache.cz ?? 0)) / MAP_SPAN) * MAP_PIXELS,
      ];
    }

    function drawOverlay() {
      fctx.clearRect(0, 0, MAP_PIXELS, MAP_PIXELS);
      // world.js keeps the authoritative discovered-biome set; fall back to
      // the hud's own copy (built from the same event) if world is missing.
      const discovered = game.world?.discovered ?? game._uiDiscoveredBiomes;
      if (discovered?.size && game.world?.biomeAt) {
        const centroids = new Map();
        const steps = 14;
        for (let gy = 0; gy < steps; gy++) {
          for (let gx = 0; gx < steps; gx++) {
            const wx = (cache.cx ?? 0) + (gx / (steps - 1) - 0.5) * MAP_SPAN;
            const wz = (cache.cz ?? 0) + (gy / (steps - 1) - 0.5) * MAP_SPAN;
            let biomeId;
            try { biomeId = game.world.biomeAt(wx, wz); } catch { continue; }
            if (!biomeId || !discovered.has(biomeId)) continue;
            const c = centroids.get(biomeId) ?? { x: 0, z: 0, n: 0 };
            c.x += wx; c.z += wz; c.n++;
            centroids.set(biomeId, c);
          }
        }
        fctx.font = '12px system-ui, sans-serif';
        fctx.fillStyle = 'rgba(216,210,196,0.85)';
        fctx.textAlign = 'center';
        for (const [biomeId, c] of centroids) {
          if (c.n < 3) continue;
          const [cx, cy] = toCanvas(c.x / c.n, c.z / c.n);
          fctx.fillText(getBiome(biomeId).name, cx, cy);
        }
      }

      // player.bindPoint (set by systems/building.js the moment a hearth is
      // placed) is the most reliable single marker; `_uiHearths` — built from
      // the `build:placed` event — covers any earlier ones from this session.
      const hearths = [...(game._uiHearths ?? [])];
      const bind = game.player?.bindPoint;
      if (bind && !hearths.some((h) => Math.hypot(h.x - bind.x, h.z - bind.z) < 1)) {
        hearths.push({ x: bind.x, z: bind.z });
      }
      if (hearths.length) {
        fctx.fillStyle = '#e0a020';
        for (const h of hearths) {
          const [hx, hy] = toCanvas(h.x, h.z);
          if (hx < -8 || hx > MAP_PIXELS + 8 || hy < -8 || hy > MAP_PIXELS + 8) continue;
          fctx.beginPath();
          fctx.moveTo(hx, hy - 6); fctx.lineTo(hx + 5, hy + 4); fctx.lineTo(hx - 5, hy + 4);
          fctx.closePath(); fctx.fill();
        }
      }

      const pos = game.player?.position ?? { x: cache.cx ?? 0, z: cache.cz ?? 0 };
      const [px, py] = toCanvas(pos.x, pos.z);
      let heading = 0;
      try { game.camera.getWorldDirection(fwd); heading = Math.atan2(fwd.x, fwd.z); } catch { heading = 0; }
      fctx.save();
      fctx.translate(px, py);
      fctx.rotate(heading);
      fctx.fillStyle = '#d8d2c4';
      fctx.beginPath();
      fctx.moveTo(0, -8); fctx.lineTo(5, 7); fctx.lineTo(0, 3); fctx.lineTo(-5, 7);
      fctx.closePath(); fctx.fill();
      fctx.restore();
    }

    function refresh(force) {
      const pos = game.player?.position;
      const moved = pos && cache.cx != null ? Math.hypot(pos.x - cache.cx, pos.z - cache.cz) : Infinity;
      if (force || cache.cx == null || moved > MAP_RESAMPLE_DIST) resample();
      drawOverlay();
    }

    return { el: elp, refresh };
  }

  // --------------------------------------------------------------------- menu
  function buildMenuPanel() {
    const elp = el('div', 'panel menu-panel');
    const inner = el('div', 'menu-inner', elp);
    const title = el('h2', 'menu-title', inner);
    title.textContent = 'Ashwake';
    const status = el('p', 'menu-status', inner);
    const list = el('div', 'menu-buttons', inner);
    const help = el('div', 'menu-help hidden', inner);
    const options = el('div', 'menu-help hidden', inner);

    const button = (label, onClick, cls) => {
      const b = el('button', `menu-btn${cls ? ' ' + cls : ''}`, list);
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };

    button('Resume', () => closeAll());

    // ---- how to play ----
    const HELP = [
      ['Moving', [
        ['W A S D', 'walk'], ['Shift', 'sprint (costs stamina)'], ['Space', 'jump'],
        ['Ctrl', 'crouch'], ['Mouse', 'look'], ['Wheel', 'zoom the camera'],
      ]],
      ['Doing things', [
        ['E', 'gather by hand: berries, flint, branches, stones, nests'],
        ['Left click', 'swing — an axe fells trees, a pickaxe breaks ore'],
        ['Right click', 'heavy attack'],
        ['F', 'block; tap it as a blow lands to parry and open a riposte'],
        ['Q', 'cast the equipped rune (needs eitr from the Vow-Tree)'],
        ['1-8', 'hotbar; drag items onto the satchel\u2019s top row to bind them'],
      ]],
      ['Panels', [
        ['I / Tab', 'satchel — right-click food to eat it'],
        ['C', 'crafting — every recipe is listed, greyed until its station is near'],
        ['V', 'the Vow-Tree — spend Oathmarks'],
        ['M', 'map'], ['Esc', 'this menu'],
      ]],
      ['Building', [
        ['Hold the Hammer', 'enters build mode'],
        ['Wheel', 'change piece'], ['R', 'rotate 45\u00b0'],
        ['Left click', 'place'], ['Right click', 'remove and refund'],
        ['', 'pieces snap to each other\u2019s edges; a roof plus two walls and a fire makes you Rested'],
      ]],
      ['Staying alive', [
        ['', 'food never hurts you — it stacks timed buffs, so eat three different things'],
        ['', 'a campfire keeps the cold off and drives greyfolk back'],
        ['', 'dying drops your unspent Oathmarks as a wisp; reclaim it with E within a day'],
        ['', 'an Ember Hearth binds where you wake'],
      ]],
    ];

    for (const [heading, rows] of HELP) {
      const h = el('h3', 'menu-help-heading', help);
      h.textContent = heading;
      for (const [key, text] of rows) {
        const row = el('div', 'menu-help-row', help);
        const k = el('kbd', 'menu-help-key', row);
        k.textContent = key;
        if (!key) k.classList.add('bare');
        const t = el('span', 'menu-help-text', row);
        t.textContent = text;
      }
    }
    const backBtn = el('button', 'menu-btn menu-help-back', help);
    backBtn.type = 'button';
    backBtn.textContent = 'Back';

    const showView = (name) => {
      list.classList.toggle('hidden', name !== 'buttons');
      status.classList.toggle('hidden', name !== 'buttons');
      help.classList.toggle('hidden', name !== 'help');
      options.classList.toggle('hidden', name !== 'settings');
    };
    backBtn.addEventListener('click', () => showView('buttons'));
    button('How to play', () => showView('help'));

    // ---- settings ----
    const optHeading = el('h3', 'menu-help-heading', options);
    optHeading.textContent = 'Settings';

    const toggleRow = (label, note, get, set) => {
      const row = el('div', 'menu-toggle', options);
      const text = el('div', 'menu-toggle-text', row);
      const name = el('div', 'menu-toggle-name', text);
      name.textContent = label;
      const desc = el('div', 'menu-toggle-note', text);
      desc.textContent = note;
      const btn = el('button', 'menu-toggle-btn', row);
      btn.type = 'button';
      const paint = () => {
        const on = !!get();
        btn.textContent = on ? 'On' : 'Off';
        btn.classList.toggle('on', on);
      };
      btn.addEventListener('click', () => { set(!get()); paint(); });
      paint();
      return paint;
    };

    const paintDebug = toggleRow(
      'Debug mode',
      '10x sprint speed and 10x damage from your own attacks. For scouting and testing.',
      () => settings.debugMode,
      (v) => setSetting('debugMode', v),
    );

    const paintDay = toggleRow(
      'Eternal day',
      'Pins the sun at noon so you can always see what you are doing. The day counter keeps running.',
      () => settings.eternalDay,
      (val) => setSetting('eternalDay', val),
    );

    const optBack = el('button', 'menu-btn menu-help-back', options);
    optBack.type = 'button';
    optBack.textContent = 'Back';
    optBack.addEventListener('click', () => showView('buttons'));

    button('Settings', () => { paintDebug(); paintDay(); showView('settings'); });

    const saveBtn = button('Save now', () => {
      try {
        game.get('save')?.write?.();
        saveBtn.textContent = 'Saved';
        setTimeout(() => { saveBtn.textContent = 'Save now'; }, 1400);
        refreshStatus();
      } catch (err) { game.debug?.('manual save failed', err); }
    });

    button('Save and quit to title', () => {
      try { game.get('save')?.write?.(); } catch { /* still leave */ }
      location.reload();
    });

    // Two-step, because it deletes the island as well as the save.
    let armed = false;
    const newBtn = button('New world', () => {
      if (!armed) {
        armed = true;
        newBtn.textContent = 'Erase this island?';
        newBtn.classList.add('armed');
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          newBtn.textContent = 'New world';
          newBtn.classList.remove('armed');
        }, 4000);
        return;
      }
      try { game.get('save')?.clearAll?.(); } catch { /* fall through to reload */ }
      location.href = location.pathname;
    }, 'danger');

    function refreshStatus() {
      const t = game.time;
      const mins = Math.floor((t?.dayFraction ?? 0) * 1440);
      const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      let saved = null;
      try { saved = game.get('save')?.savedAt?.() ?? null; } catch { saved = null; }
      const ago = saved ? Math.max(0, Math.round((Date.now() - saved) / 1000)) : null;
      const savedText = ago === null ? 'not saved yet'
        : ago < 60 ? `saved ${ago}s ago`
        : `saved ${Math.round(ago / 60)}m ago`;
      status.textContent = `Day ${t?.day ?? 1} · ${clock} · ${savedText}`;
    }

    return {
      el: elp,
      refresh() { refreshStatus(); },
      onOpen() { showView('buttons'); },
    };
  }

  // ------------------------------------------------------------------- system
  function build() {
    root = el('div', 'ui-panels');
    document.getElementById('ui-root')?.appendChild(root);
    panels.inventory = buildInventoryPanel();
    panels.crafting = buildCraftingPanel();
    panels.vowtree = buildVowtreePanel();
    panels.map = buildMapPanel();
    panels.menu = buildMenuPanel();
    for (const p of Object.values(panels)) root.appendChild(p.el);

    // A shared close button + backdrop click, since panels are full-bleed.
    // fixedUpdate doesn't run while paused, so Escape out of the menu is wired
    // straight to the document.
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || openPanel !== 'menu') return;
      e.preventDefault();
      escapeGuard = performance.now();
      closeAll();
    });

    const closeBtn = el('button', 'panel-close', root);
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeAll);
  }

  function refresh(name, force) {
    panels[name]?.refresh(force);
  }

  return {
    name: 'panels',
    init(game) {
      try { build(); } catch (err) { game.debug?.('panels build failed', err); }
    },
    fixedUpdate(dt, game) {
      const input = game.input;
      if (!input?.wasPressed) return;
      if (input.wasPressed('inventory')) openPanelByName('inventory');
      if (input.wasPressed('crafting')) openPanelByName('crafting');
      if (input.wasPressed('vowtree')) openPanelByName('vowtree');
      if (input.wasPressed('map')) openPanelByName('map');
      if (input.wasPressed('escape') && performance.now() - escapeGuard > 350) {
        if (openPanel) closeAll();
        else openPanelByName('menu');
      }
    },
    update(dt) {
      if (!openPanel) return;
      acc += dt;
      if (acc < REFRESH_HZ) return;
      acc = 0;
      try { refresh(openPanel, false); } catch (err) { game.debug?.('panel refresh failed', err); }
    },
    dispose() { root?.remove(); },
  };
}
