import { getItem } from '../data/items.js';
import { clamp } from '../core/math.js';

const SLOT_COUNT = 32;
const HOTBAR_SIZE = 8;
const BASE_CAPACITY = 300;

/**
 * Inventory: 32 flat slots (0..7 are the hotbar), plus two dedicated
 * equipment holders (shield, rune) that live outside the grid — the active
 * "weapon" is just whatever item sits in the selected hotbar slot, per
 * ARCHITECTURE.md's `inv.equipped`.
 */
export function createInventory(game) {
  const slots = new Array(SLOT_COUNT).fill(null);
  const equipment = { shield: null, rune: null };
  let selected = 0;

  function itemCount(itemId) {
    let total = 0;
    for (const s of slots) if (s && s.id === itemId) total += s.count;
    if (equipment.shield === itemId) total += 1;
    if (equipment.rune === itemId) total += 1;
    return total;
  }

  function add(itemId, amount) {
    const def = getItem(itemId);
    if (!def || !(amount > 0)) return 0;
    const maxStack = def.stack ?? 1;
    let remaining = Math.floor(amount);

    // Top up existing partial stacks first, then spill into empty slots.
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      const s = slots[i];
      if (s && s.id === itemId && s.count < maxStack) {
        const take = Math.min(maxStack - s.count, remaining);
        s.count += take;
        remaining -= take;
      }
    }
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      if (!slots[i]) {
        const take = Math.min(maxStack, remaining);
        slots[i] = { id: itemId, count: take };
        remaining -= take;
      }
    }

    const added = Math.floor(amount) - remaining;
    if (added > 0) {
      recalcWeight();
      game.bus.emit('item:gained', { id: itemId, count: added });
    }
    return added;
  }

  function remove(itemId, amount) {
    if (!(amount > 0)) return true;
    if (itemCount(itemId) < amount) return false;
    let remaining = amount;
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      const s = slots[i];
      if (s && s.id === itemId) {
        const take = Math.min(s.count, remaining);
        s.count -= take;
        remaining -= take;
        if (s.count <= 0) slots[i] = null;
      }
    }
    recalcWeight();
    return true;
  }

  function recalcWeight() {
    let w = 0;
    for (const s of slots) {
      if (!s) continue;
      const def = getItem(s.id);
      if (def) w += (def.weight ?? 0) * s.count;
    }
    if (equipment.shield) w += getItem(equipment.shield)?.weight ?? 0;
    if (equipment.rune) w += getItem(equipment.rune)?.weight ?? 0;
    inv.weight = w;
    inv.capacity = BASE_CAPACITY * (game.progression?.effects?.carryMult ?? 1);
    inv.overweight = w > inv.capacity;
  }

  function selectHotbar(i) {
    selected = clamp(Math.floor(i), 0, HOTBAR_SIZE - 1);
  }

  /** Move an item from the grid into a dedicated equipment holder, or clear it (itemId == null). */
  function equipToSlot(kind, itemId) {
    if (itemId == null) {
      const prev = equipment[kind];
      if (prev) {
        add(prev, 1);
        equipment[kind] = null;
        recalcWeight();
      }
      return true;
    }
    const def = getItem(itemId);
    if (!def || def.kind !== kind) return false;
    if (!remove(itemId, 1)) return false;
    const prev = equipment[kind];
    if (prev) add(prev, 1);
    equipment[kind] = itemId;
    recalcWeight();
    return true;
  }

  // The wheel belongs to the camera (zoom) and, in build mode, to the piece
  // list. The hotbar is keys 1-8 only — scrolling past your axe mid-fight was
  // never worth the convenience.

  const inv = {
    name: 'inventory',
    slots,
    equipment,
    weight: 0,
    capacity: BASE_CAPACITY,
    overweight: false,

    get selected() { return selected; },
    get equipped() {
      const s = slots[selected];
      return s ? getItem(s.id) ?? null : null;
    },

    add,
    remove,
    count: itemCount,
    selectHotbar,
    equipShield: (id) => equipToSlot('shield', id),
    equipRune: (id) => equipToSlot('rune', id),

    init() {
      // Harvest drops are minted by world.resources.damage(); this is the only
      // place they turn into carried items.
      game.bus.on('resource:harvested', (e) => {
        for (const d of e?.drops ?? []) add(d.item, d.count);
      });

      // The only hand-holding the game does: a starting kit for a fresh player.
      // A loaded save's hydrate() runs after init() and overwrites this.
      add('wood', 5);
      add('stone', 2);
      add('raspberries', 3);
    },

    fixedUpdate(dt) {
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        if (game.input.wasPressed(`hotbar${i + 1}`)) selectHotbar(i);
      }
      recalcWeight();
    },

    serialize() {
      return {
        slots: slots.map((s) => (s ? { id: s.id, count: s.count } : null)),
        selected,
        equipment: { ...equipment },
      };
    },

    hydrate(data) {
      if (!data) return;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = data.slots?.[i];
        slots[i] = s ? { id: s.id, count: s.count } : null;
      }
      selected = clamp(data.selected ?? 0, 0, HOTBAR_SIZE - 1);
      equipment.shield = data.equipment?.shield ?? null;
      equipment.rune = data.equipment?.rune ?? null;
      recalcWeight();
    },

    dispose() {},
  };

  return inv;
}
