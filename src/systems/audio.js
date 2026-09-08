import { clamp, damp } from '../core/math.js';

const MATERIAL_TONE = { wood: 900, stone: 1800, dirt: 500, grass: 650, sand: 550, water: 400, metal: 2400 };

/**
 * Procedural WebAudio only — no external files. Everything is synthesised
 * noise/oscillators shaped with envelopes and filters. The AudioContext is
 * created lazily on the first user gesture (browsers refuse it otherwise),
 * and every entry point is guarded so a failure here never breaks the game.
 */
export function createAudio(game) {
  let ctx = null;
  let failed = false;
  let masterGain = null;
  let noiseBuffer = null;
  let windSource = null, windGain = null;
  let droneOscA = null, droneOscB = null, droneGain = null;
  let windCurrent = 0.05;

  function makeNoiseBuffer(c, seconds = 2) {
    const length = Math.floor(c.sampleRate * seconds);
    const buffer = c.createBuffer(1, length, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function setupWindBed(c) {
    windSource = c.createBufferSource();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    windGain = c.createGain();
    windGain.gain.value = windCurrent;
    windSource.connect(filter).connect(windGain).connect(masterGain);
    windSource.start();
  }

  function setupNightDrone(c) {
    droneOscA = c.createOscillator();
    droneOscA.type = 'sine';
    droneOscA.frequency.value = 52;
    droneOscB = c.createOscillator();
    droneOscB.type = 'sine';
    droneOscB.frequency.value = 55; // slight detune for a low, uneasy beat
    droneGain = c.createGain();
    droneGain.gain.value = game.time?.isNight ? 0.08 : 0;
    droneOscA.connect(droneGain);
    droneOscB.connect(droneGain);
    droneGain.connect(masterGain);
    droneOscA.start();
    droneOscB.start();
  }

  function ensureContext() {
    if (ctx || failed) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return null; }
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.6;
      masterGain.connect(ctx.destination);
      noiseBuffer = makeNoiseBuffer(ctx);
      setupWindBed(ctx);
      setupNightDrone(ctx);
    } catch (err) {
      failed = true;
      ctx = null;
      game.debug('audio init failed', err);
    }
    return ctx;
  }

  function onFirstGesture() {
    const c = ensureContext();
    if (c?.state === 'suspended') c.resume().catch(() => {});
    removeEventListener('pointerdown', onFirstGesture);
    removeEventListener('keydown', onFirstGesture);
  }
  addEventListener('pointerdown', onFirstGesture, { passive: true });
  addEventListener('keydown', onFirstGesture);

  function rampDrone(nightOn) {
    if (!ctx || !droneGain) return;
    const now = ctx.currentTime;
    const target = nightOn ? 0.08 : 0;
    droneGain.gain.cancelScheduledValues(now);
    droneGain.gain.setValueAtTime(droneGain.gain.value, now);
    droneGain.gain.linearRampToValueAtTime(target, now + 4);
  }

  function playNote(c, freq, t0, dur, gain) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  function playTwoNote(c, { f1, f2, gap = 0.16, dur = 0.14, gain = 0.18 }) {
    const t0 = c.currentTime;
    playNote(c, f1, t0, dur, gain);
    playNote(c, f2, t0 + gap, dur * 1.3, gain);
  }

  function playFootstep(c, { material = 'dirt' } = {}) {
    const t0 = c.currentTime;
    const freq = MATERIAL_TONE[material] ?? MATERIAL_TONE.dirt;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.16, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
    src.connect(filter).connect(g).connect(masterGain);
    src.start(t0);
    src.stop(t0 + 0.1);
    src.onended = () => { src.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  function playBowDraw(c, { duration = 0.7 } = {}) {
    const t0 = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(300, t0);
    filter.frequency.linearRampToValueAtTime(1400, t0 + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
    g.gain.setValueAtTime(0.12, t0 + Math.max(0.05, duration - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(g).connect(masterGain);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
    src.onended = () => { src.disconnect(); filter.disconnect(); g.disconnect(); };
  }

  function playImpact(c, { amount = 10 } = {}) {
    const t0 = c.currentTime;
    const vol = clamp(amount / 40, 0.25, 1) * 0.5;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.15);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + 0.25);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };

    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;
    const ng = c.createGain();
    ng.gain.setValueAtTime(vol * 0.6, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    src.connect(filter).connect(ng).connect(masterGain);
    src.start(t0);
    src.stop(t0 + 0.12);
    src.onended = () => { src.disconnect(); filter.disconnect(); ng.disconnect(); };
  }

  const VOICES = {
    footstep: playFootstep,
    bow_draw: playBowDraw,
    impact: playImpact,
    discovery: (c) => playTwoNote(c, { f1: 440, f2: 660 }),
    craft: (c) => playTwoNote(c, { f1: 523, f2: 784, gap: 0.09, dur: 0.09, gain: 0.14 }),
    build: (c) => playImpact(c, { amount: 25 }),
  };

  function play(name, opts) {
    if (failed) return;
    const c = ensureContext();
    if (!c || c.state !== 'running') return; // silently no-op until unlocked by a gesture
    const fn = VOICES[name];
    if (!fn) return;
    try { fn(c, opts); } catch (err) { game.debug('audio play failed', name, err); }
  }

  return {
    name: 'audio',
    play,

    init(game) {
      game.bus.on('resource:hit', (e) => play('impact', { amount: e?.amount ?? 10 }));
      game.bus.on('player:damaged', (e) => play('impact', { amount: e?.hit?.amount ?? e?.amount ?? 15 }));
      game.bus.on('entity:killed', () => play('impact', { amount: 30 }));
      game.bus.on('craft:completed', () => play('craft'));
      game.bus.on('build:placed', () => play('build'));
      game.bus.on('biome:discovered', () => play('discovery'));
      game.bus.on('time:dusk', () => rampDrone(true));
      game.bus.on('time:dawn', () => rampDrone(false));
    },

    // Wind is the one continuously-live voice: its gain follows the player's
    // altitude and biome, so it needs a per-frame (not event-driven) nudge.
    update(dt) {
      if (!ctx || !windGain) return;
      const pos = game.player?.position;
      const altitude = pos ? pos.y : 0;
      const biome = pos && game.world?.biomeAt ? game.world.biomeAt(pos.x, pos.z) : null;
      let target = 0.05 + clamp(altitude / 120, 0, 1) * 0.12;
      if (biome === 'frostreach') target += 0.08;
      else if (biome === 'myrkvid') target -= 0.02;
      else if (biome === 'ashwake') target -= 0.03; // "no wind" per VISION.md
      target = clamp(target, 0.01, 0.3);
      windCurrent = damp(windCurrent, target, 2, dt);
      windGain.gain.value = windCurrent;
    },

    dispose() {
      removeEventListener('pointerdown', onFirstGesture);
      removeEventListener('keydown', onFirstGesture);
      try { windSource?.stop(); } catch (err) { /* already stopped */ }
      try { droneOscA?.stop(); droneOscB?.stop(); } catch (err) { /* already stopped */ }
      try { ctx?.close(); } catch (err) { /* already closed */ }
    },
  };
}
