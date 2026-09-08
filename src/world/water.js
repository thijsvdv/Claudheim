import * as THREE from 'three';

/**
 * One big plane at y = 0. Waves are two scrolling sine bands plus a fast
 * chop band, differentiated analytically for a normal — no textures, no
 * geometry subdivision. It renders in the transparent pass with depth writes
 * off, so it can never z-fight the terrain it intersects at the shoreline.
 */

const SIZE = 4000;

const VERT = /* glsl */`
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
    vWorld = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSky;
  uniform vec3 uSunColour;
  uniform vec3 uSunDir;
  uniform float uNight;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>

  void main() {
    vec2 p = vWorld.xz;
    float a1 = p.x * 0.090 + p.y * 0.050 + uTime * 0.90;
    float a2 = p.x * -0.045 + p.y * 0.115 + uTime * 0.62;
    float a3 = ( p.x + p.y ) * 0.210 - uTime * 1.70;

    float dhx = 0.30 * 0.090 * cos( a1 ) - 0.22 * 0.045 * cos( a2 ) + 0.06 * 0.210 * cos( a3 );
    float dhz = 0.30 * 0.050 * cos( a1 ) + 0.22 * 0.115 * cos( a2 ) + 0.06 * 0.210 * cos( a3 );
    vec3 n = normalize( vec3( -dhx * 3.2, 1.0, -dhz * 3.2 ) );

    vec3 v = normalize( cameraPosition - vWorld );
    float ndv = clamp( dot( n, v ), 0.0, 1.0 );
    float fres = pow( 1.0 - ndv, 3.0 );

    // Glancing angles read as reflected sky, steep angles as depth.
    vec3 col = mix( uDeep, uShallow, clamp( ndv * 1.25, 0.0, 1.0 ) );
    col = mix( col, uSky, fres * 0.72 );

    float spec = pow( max( dot( reflect( -v, n ), uSunDir ), 0.0 ), 90.0 );
    col += uSunColour * spec * 1.6;

    // A little foam where the two long bands crest together.
    float crest = smoothstep( 0.86, 1.0, sin( a1 ) * 0.5 + sin( a2 ) * 0.5 + 0.5 );
    col = mix( col, mix( uShallow, vec3( 1.0 ), 0.55 ), crest * 0.18 * ( 1.0 - uNight * 0.7 ) );

    gl_FragColor = vec4( col, mix( 0.93, 0.74, fres ) );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function createWater(game) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x0f2530) },
      uShallow: { value: new THREE.Color(0x2f6a72) },
      uSky: { value: new THREE.Color(0x9fb8c8) },
      uSunColour: { value: new THREE.Color(0xffe9c4) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });

  const geometry = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.position.y = 0;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  const _dir = new THREE.Vector3();

  return {
    mesh, material, uniforms,

    /** Sky pushes its lighting here each frame so the sea tracks the sun. */
    setLighting(sunDir, sunColour, skyColour, night) {
      if (sunDir) uniforms.uSunDir.value.copy(_dir.copy(sunDir).normalize());
      if (sunColour) uniforms.uSunColour.value.copy(sunColour);
      if (skyColour) uniforms.uSky.value.copy(skyColour);
      if (night != null) {
        uniforms.uNight.value = night;
        const d = 1 - night * 0.78;
        uniforms.uDeep.value.setRGB(0.024 * d, 0.075 * d + night * 0.012, 0.115 * d + night * 0.02);
        uniforms.uShallow.value.setRGB(0.09 * d, 0.24 * d, 0.27 * d + night * 0.03);
      }
    },

    update(dt) { uniforms.uTime.value += dt; },

    dispose() { geometry.dispose(); material.dispose(); },
  };
}
