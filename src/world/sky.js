import * as THREE from 'three';
import { clamp, lerp, smoothstep, damp, TAU } from '../core/math.js';
import { BIOMES, getBiome } from '../data/biomes.js';

/**
 * Sun, moon, sky dome and fog. Everything derives from `game.time.dayFraction`,
 * which game.js pins to 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. Only the sun
 * casts shadows, and its shadow camera rides the player, so there are no
 * cascades to pay for.
 */

const DOME_RADIUS = 1400;
const SHADOW_EXTENT = 58;
const SHADOW_DISTANCE = 140;
const STAR_COUNT = 900;

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColour;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uNight;
  varying vec3 vDir;
  #include <common>

  void main() {
    vec3 d = normalize( vDir );
    float t = smoothstep( -0.04, 0.62, d.y );
    vec3 col = mix( uHorizon, uZenith, pow( t, 0.85 ) );
    col = mix( uGround, col, smoothstep( -0.28, 0.015, d.y ) );

    float sd = dot( d, uSunDir );
    col += uSunColour * pow( max( sd, 0.0 ), 900.0 ) * 3.0;
    col += uSunColour * pow( max( sd, 0.0 ), 7.0 ) * 0.34 * ( 1.0 - uNight );

    float md = dot( d, uMoonDir );
    col += vec3( 0.78, 0.84, 1.0 ) * pow( max( md, 0.0 ), 1600.0 ) * 2.4 * uNight;
    col += vec3( 0.30, 0.40, 0.68 ) * pow( max( md, 0.0 ), 26.0 ) * 0.12 * uNight;

    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeStars() {
  const pos = new Float32Array(STAR_COUNT * 3);
  // Deterministic-enough: stars are decoration, not world state.
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < STAR_COUNT; i++) {
    const u = rnd() * 2 - 1;
    const a = rnd() * TAU;
    const r = Math.sqrt(1 - u * u);
    // Bias toward the upper hemisphere; nobody looks at stars below the sea.
    const y = Math.abs(u) * 0.92 + 0.06;
    pos[i * 3] = Math.cos(a) * r * (DOME_RADIUS * 0.96);
    pos[i * 3 + 1] = y * (DOME_RADIUS * 0.96);
    pos[i * 3 + 2] = Math.sin(a) * r * (DOME_RADIUS * 0.96);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

export function createSky(game) {
  const uniforms = {
    uZenith: { value: new THREE.Color(0x4f83b4) },
    uHorizon: { value: new THREE.Color(0xbcd2de) },
    uGround: { value: new THREE.Color(0x394048) },
    uSunColour: { value: new THREE.Color(0xfff4e0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uNight: { value: 0 },
  };

  const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 18);
  const domeMat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skydome';
  dome.renderOrder = -1000;
  dome.frustumCulled = false;

  const starGeo = makeStars();
  const starMat = new THREE.PointsMaterial({
    color: 0xdfe8ff, size: 2.0, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -999;
  stars.frustumCulled = false;

  const sun = new THREE.DirectionalLight(0xfff4e0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SHADOW_DISTANCE + SHADOW_EXTENT * 2;
  sun.shadow.camera.left = -SHADOW_EXTENT;
  sun.shadow.camera.right = SHADOW_EXTENT;
  sun.shadow.camera.top = SHADOW_EXTENT;
  sun.shadow.camera.bottom = -SHADOW_EXTENT;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;

  const moon = new THREE.DirectionalLight(0x93aee0, 0);
  const hemi = new THREE.HemisphereLight(0xbcd2de, 0x4a4a3c, 0.5);

  const fog = new THREE.FogExp2(0xc8d8e0, 0.0035);

  const sunDir = new THREE.Vector3(0, 1, 0);
  const moonDir = new THREE.Vector3(0, -1, 0);
  const focus = new THREE.Vector3();
  const _c = new THREE.Color();
  const fogColour = new THREE.Color(0xc8d8e0);
  let fogDensity = 0.0035;
  let biomeId = 'fjaldmark';
  let biomeTimer = 0;

  const DAY_HORIZON = new THREE.Color(0xbcd2de);
  const DAY_ZENITH = new THREE.Color(0x4f83b4);
  const NIGHT_HORIZON = new THREE.Color(0x121c2c);
  const NIGHT_ZENITH = new THREE.Color(0x060a14);
  const DUSK = new THREE.Color(0xe08a4e);
  const SUN_LOW = new THREE.Color(0xff9b52);
  const SUN_HIGH = new THREE.Color(0xfff4e0);
  const MOON_COL = new THREE.Color(0x93aee0);

  function focusPosition(out) {
    const p = game.player?.position || game.player?.object?.position;
    if (p) return out.copy(p);
    return out.copy(game.camera.position);
  }

  const system = {
    name: 'sky',
    sun, moon, hemi, dome, stars, fog,
    sunDirection: sunDir,
    moonDirection: moonDir,
    get dayness() { return smoothstep(-0.12, 0.2, sunDir.y); },

    init(g) {
      const scene = g.scene;
      scene.add(dome, stars, sun, sun.target, moon, moon.target, hemi);
      scene.fog = fog;
      // Paint the first frame with the right colours rather than the defaults.
      system.update(0, g);
    },

    update(dt, g) {
      const t = g.time;
      // 0.25 -> sun on the eastern horizon, 0.5 -> overhead, 0.75 -> setting.
      const a = (t.dayFraction - 0.25) * TAU;
      sunDir.set(Math.cos(a), Math.sin(a), -0.35).normalize();
      moonDir.copy(sunDir).negate();

      const dayness = smoothstep(-0.12, 0.2, sunDir.y);
      const night = 1 - dayness;
      const golden = 1 - smoothstep(0.02, 0.34, Math.abs(sunDir.y));

      focusPosition(focus);
      dome.position.copy(g.camera.position);
      stars.position.copy(g.camera.position);

      // --- biome fog target, sampled lazily; it only has to feel right ---
      biomeTimer -= dt;
      if (biomeTimer <= 0) {
        biomeTimer = 0.3;
        const w = g.world || g.get?.('world');
        if (w?.biomeAt) {
          try { biomeId = w.biomeAt(focus.x, focus.z); } catch { /* pre-init */ }
        }
      }
      const biome = getBiome(biomeId) || BIOMES.fjaldmark;

      // --- lights ---
      _c.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(0.0, 0.35, sunDir.y));
      sun.color.copy(_c);
      sun.intensity = dayness * 2.4;
      sun.castShadow = dayness > 0.03;
      uniforms.uSunColour.value.copy(_c);

      moon.color.copy(MOON_COL);
      moon.intensity = night * 0.12;

      hemi.intensity = lerp(0.17, 0.72, dayness);
      hemi.color.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayness);
      _c.set(biome.ground);
      hemi.groundColor.copy(_c).multiplyScalar(lerp(0.35, 1, dayness));

      // Shadow camera rides the player, snapped so the map does not shimmer.
      const sx = Math.round(focus.x), sz = Math.round(focus.z);
      sun.target.position.set(sx, Math.round(focus.y), sz);
      sun.position.set(
        sx + sunDir.x * SHADOW_DISTANCE,
        focus.y + sunDir.y * SHADOW_DISTANCE,
        sz + sunDir.z * SHADOW_DISTANCE);
      sun.target.updateMatrixWorld();

      moon.target.position.copy(sun.target.position);
      moon.position.set(
        sx + moonDir.x * 200, focus.y + Math.abs(moonDir.y) * 200 + 40, sz + moonDir.z * 200);
      moon.target.updateMatrixWorld();

      // --- sky dome ---
      uniforms.uHorizon.value.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayness);
      uniforms.uHorizon.value.lerp(DUSK, golden * 0.55 * dayness);
      uniforms.uZenith.value.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, dayness);
      uniforms.uGround.value.copy(uniforms.uHorizon.value).multiplyScalar(0.55);
      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uMoonDir.value.copy(moonDir);
      uniforms.uNight.value = night;
      starMat.opacity = clamp(night * 1.15 - 0.1, 0, 1);
      stars.visible = starMat.opacity > 0.01;

      // --- fog: biome colour, dimmed and blued at night ---
      _c.set(biome.fog);
      _c.lerp(uniforms.uHorizon.value, 0.35);
      _c.multiplyScalar(lerp(0.16, 1, dayness));
      const k = dt > 0 ? damp(0, 1, 3.5, dt) : 1;
      fogColour.lerp(_c, k);
      const targetDensity = (biome.fogDensity ?? 0.0035) * lerp(1.55, 1, dayness);
      fogDensity = lerp(fogDensity, targetDensity, k);
      fog.color.copy(fogColour);
      fog.density = fogDensity;
      g.renderer.setClearColor(fogColour, 1);

      // The sea reads its lighting from here so the two never disagree.
      const water = (g.world || g.get?.('world'))?.water;
      water?.setLighting?.(sunDir, sun.color, uniforms.uHorizon.value, night);
    },

    /** Current biome under the player, cached for the HUD/audio. */
    get biome() { return biomeId; },

    dispose() {
      game.scene.remove(dome, stars, sun, sun.target, moon, moon.target, hemi);
      if (game.scene.fog === fog) game.scene.fog = null;
      domeGeo.dispose(); domeMat.dispose();
      starGeo.dispose(); starMat.dispose();
      sun.dispose?.(); moon.dispose?.(); hemi.dispose?.();
    },
  };

  return system;
}
