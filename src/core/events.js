export class EventBus {
  constructor() { this.map = new Map(); }

  on(evt, fn) {
    let set = this.map.get(evt);
    if (!set) { set = new Set(); this.map.set(evt, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  once(evt, fn) {
    const off = this.on(evt, (p) => { off(); fn(p); });
    return off;
  }

  emit(evt, payload) {
    const set = this.map.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[bus:${evt}]`, err); }
    }
  }
}
