import * as THREE from 'three';
import { EventBus } from './events.js';
import { EntityRegistry } from './entities.js';
import { createLoop } from './loop.js';
import { createInput } from './input.js';

const DAY_LENGTH = 15 * 60; // seconds of real time per in-game day

export class Game {
  constructor(canvas, { seed = 1337, debug = false } = {}) {
    this.canvas = canvas;
    this.seed = seed;
    this.debugEnabled = debug;
    this.bus = new EventBus();
    this.entities = new EntityRegistry();
    this.systems = [];
    this.byName = new Map();
    this.paused = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 2000);
    this.scene.add(this.camera);

    this.input = createInput(canvas, this.bus);

    // Day 1 starts at dawn so the player's first minutes are lit.
    this.time = { elapsed: 0, dayFraction: 0.25, day: 1, isNight: false, dayLength: DAY_LENGTH };

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.resize();

    this.loop = createLoop({
      fixed: (dt) => this.fixedUpdate(dt),
      render: (dt, alpha) => this.render(dt, alpha),
    });
  }

  register(system) {
    this.systems.push(system);
    if (system.name) {
      this.byName.set(system.name, system);
      if (!this[system.name]) this[system.name] = system;
    }
    return system;
  }

  get(name) { return this.byName.get(name); }

  init() {
    for (const s of this.systems) s.init?.(this);
    this.bus.emit('game:ready', this);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  advanceTime(dt) {
    const t = this.time;
    t.elapsed += dt;
    t.dayFraction += dt / t.dayLength;
    while (t.dayFraction >= 1) { t.dayFraction -= 1; t.day++; }
    const night = t.dayFraction < 0.2 || t.dayFraction > 0.8;
    if (night !== t.isNight) {
      t.isNight = night;
      this.bus.emit(night ? 'time:dusk' : 'time:dawn', t);
    }
  }

  fixedUpdate(dt) {
    if (this.paused) { this.input.endStep(); return; }
    this.advanceTime(dt);
    for (const s of this.systems) s.fixedUpdate?.(dt, this);
    this.input.endStep();
  }

  render(dt, alpha) {
    for (const s of this.systems) s.update?.(dt, this, alpha);
    this.renderer.render(this.scene, this.camera);
  }

  debug(...args) { if (this.debugEnabled) console.info('[ashwake]', ...args); }

  start() { this.loop.start(); }
  stop() { this.loop.stop(); }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
  }
}
