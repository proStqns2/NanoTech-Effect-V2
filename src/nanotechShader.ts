import * as THREE from 'three';

/**
 * Photorealistic Iron Man Mark LXXXV PBR + Liquid-Metal Nanotech Shader (GLSL).
 *
 * Implements the exact Cartesian Caramel Blender shader workflow (https://youtu.be/eI2p6hNi6w8)
 * enhanced with ILM-style automotive candy-coat flop, fine anisotropic brushed titanium-gold grain,
 * plate-border cavity ambient occlusion, and real-time webcam room-light color matching:
 *
 *  1. Chest Arc Reactor Empty Distance: length((worldPos - uNanoOrigin) / uBodyScale) - uNanoProgress
 *  2. 3D Object-Space FBM Noise (detail = 3) + fine nanite cellular breakup warping the edge
 *  3. Crisp Alpha-Clip reveal + coalescing liquid-chrome precursor droplets ahead of wavefront
 *  4. Map Range (SmootherStep) × 1D Liquid Wave Noise(gradient) -> Negative 3D Surface Bump
 *  5. Eased Color & Roughness Mix: Molten Gunmetal-Silver Liquid Metal -> Candy Crimson & Champagne Gold
 *  6. Independent Faceplate Visor Nanotech Sweep (closes/opens seamlessly over the user's real face)
 */

export type NanotechSharedUniforms = {
  uNanoOrigin: { value: THREE.Vector3 };
  uVisorOrigin: { value: THREE.Vector3 };
  uBodyScale: { value: number };
  uFaceScale: { value: number };
  uNanoProgress: { value: number };
  uVisorProgress: { value: number };
  uArmorTime: { value: number };
  uRoomTint: { value: THREE.Color };
  uWarpStrength: { value: number };
  uRippleScale: { value: number };
  uWaveWidth: { value: number };
  uBumpDepth: { value: number };
  uDirectionSign: { value: number };
};

export type Mark85Materials = {
  uniforms: NanotechSharedUniforms;
  /** Automotive two-stage candy ruby-crimson (chest, abs, helmet dome, forearms, gauntlets, shins) */
  crimson: THREE.MeshPhysicalMaterial;
  /** Brushed champagne-bronze titanium-gold (shoulders, biceps, thighs, clavicle/rib accents, belt) */
  gold: THREE.MeshPhysicalMaterial;
  /** Articulated Mark 85 brushed gold faceplate (supports independent visor open/close) */
  faceplateGold: THREE.MeshPhysicalMaterial;
  /** Recessed dark titanium faceplate eye socket & mouth groove (retracts with faceplate) */
  faceplateDark: THREE.MeshPhysicalMaterial;
  /** Glowing white-cyan Iron Man eye lenses (retracts with faceplate) */
  faceplateEye: THREE.MeshPhysicalMaterial;
  /** Machined gunmetal silver-titanium (joints, ear pods, rib slats, mechanical trim) */
  titanium: THREE.MeshPhysicalMaterial;
  /** Continuous dark carbon-hex nanotech muscular undersuit (leads outer armor wave!) */
  undersuit: THREE.MeshPhysicalMaterial;
  /** Recessed Mark 85 RT energy lights (clavicle nodes, lower-pec slits, forearm nodes) */
  rtLight: THREE.MeshPhysicalMaterial;
  /** Standalone Chest Arc Reactor pod materials */
  reactorBezel: THREE.MeshPhysicalMaterial;
  reactorLattice: THREE.MeshStandardMaterial;
  reactorCore: THREE.MeshBasicMaterial;
  allMaterials: THREE.Material[];
  dispose: () => void;
};

type RoleConfig = {
  cacheKey: string;
  gradOffset: number;
  noiseScale: number;
  useVisorMask: boolean;
  isCandyRed: boolean;
  isBrushedGold: boolean;
  isUndersuit: boolean;
  isEnergy: boolean;
};

const VERT_COMMON = /* glsl */ `
#include <common>
uniform vec3 uNanoOrigin;
uniform float uBodyScale;
uniform float uNanoProgress;
uniform float uArmorTime;
varying vec3 vNanoWorldPos;
varying vec3 vNanoLocalPos;
varying vec3 vNanoObjNormal;
`;

const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
vNanoLocalPos = position;
vNanoObjNormal = normalize(objectNormal);
vec4 nanoWpPre = modelMatrix * vec4(transformed, 1.0);
vec3 nanoRv = (nanoWpPre.xyz - uNanoOrigin) / max(uBodyScale, 24.0);
float nanoDv = length(vec3(nanoRv.xy, nanoRv.z * 0.2));
float nanoGv = nanoDv - uNanoProgress;
// Physical 3D silhouette ripple along the forming liquid-metal band
float nanoEnvV = smoothstep(-0.50, -0.04, nanoGv) * (1.0 - smoothstep(-0.01, 0.24, nanoGv));
float nanoRipV = sin(nanoGv * 32.0 - uArmorTime * 7.2 + position.x * 10.0 + position.y * 12.0);
transformed += objectNormal * (nanoEnvV * (nanoRipV * 0.015 - 0.014));
`;

const VERT_PROJECT = /* glsl */ `
vec4 nanoWpFinal = modelMatrix * vec4(transformed, 1.0);
vNanoWorldPos = nanoWpFinal.xyz;
#include <project_vertex>
`;

const FRAG_COMMON = /* glsl */ `
#include <common>
uniform vec3 uNanoOrigin;
uniform vec3 uVisorOrigin;
uniform float uBodyScale;
uniform float uFaceScale;
uniform float uNanoProgress;
uniform float uVisorProgress;
uniform float uArmorTime;
uniform vec3 uRoomTint;
uniform float uWarpStrength;
uniform float uRippleScale;
uniform float uWaveWidth;
uniform float uBumpDepth;
uniform float uDirectionSign;

uniform float uGradOffset;
uniform float uNoiseScale;
uniform float uUseVisorMask;
uniform float uIsCandyRed;
uniform float uIsBrushedGold;
uniform float uIsUndersuit;
uniform float uIsEnergy;

varying vec3 vNanoWorldPos;
varying vec3 vNanoLocalPos;
varying vec3 vNanoObjNormal;

// Exact Blender Map Range -> Smoother Step (6t^5 - 15t^4 + 10t^3)
float nanoSmootherstep(float t) {
  float x = clamp(t, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

float nanoHash1(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float nanoHash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// 1D multi-octave noise (Cartesian Caramel 1D Noise Texture on gradient -> liquid metal ripples)
float nanoNoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(nanoHash1(i), nanoHash1(i + 1.0), u);
}

float nanoFbm1(float x) {
  float v = 0.0;
  float a = 0.54;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    v += a * nanoNoise1(x * freq);
    freq *= 2.11;
    a *= 0.5;
  }
  return clamp(v / 0.945, 0.0, 1.0);
}

// 3D smooth gradient-like noise + 3-octave FBM (Blender 3D Noise Texture, Detail = 3.0)
float nanoNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = nanoHash3(i);
  float n100 = nanoHash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = nanoHash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = nanoHash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = nanoHash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = nanoHash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = nanoHash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = nanoHash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

float nanoFbm3(vec3 p) {
  float v = 0.0;
  float a = 0.53;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    v += a * nanoNoise3(p * freq);
    p = p.yzx + vec3(7.31, 4.19, 11.73);
    freq *= 2.06;
    a *= 0.5;
  }
  return clamp(v / 0.9275, 0.0, 1.0);
}

// Fine Stark micro-hexagonal nanite mesh: returns (distFromSeam, tileHash)
vec2 nanoHex(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hC.xy * s, p - (hC.zw + 0.5) * s);
  bool a = dot(h.xy, h.xy) < dot(h.zw, h.zw);
  vec2 loc = a ? h.xy : h.zw;
  vec2 id = a ? hC.xy : (hC.zw + 0.5);
  vec2 ab = abs(loc);
  float r = max(dot(ab, s * 0.5), ab.x);
  return vec2(0.5 - r, nanoHash3(vec3(id, 3.7)));
}

// Morten Mikkelsen surface-gradient bump mapping (matches Blender Vector -> Bump node)
vec3 nanoPerturbNormal(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sX = dFdx(surfPos);
  vec3 sY = dFdy(surfPos);
  float lX = max(length(sX), 1e-4);
  float lY = max(length(sY), 1e-4);
  sX /= lX;
  sY /= lY;
  vec3 r1 = cross(sY, surfNorm);
  vec3 r2 = cross(surfNorm, sX);
  float det = dot(sX, r1) * faceDir;
  if (abs(det) < 1e-4) return surfNorm;
  vec2 slope = clamp(dHdxy / vec2(lX, lY), vec2(-2.35), vec2(2.35));
  return normalize(abs(det) * surfNorm - sign(det) * (slope.x * r1 + slope.y * r2));
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>

// 1. Radial 3D distance from Chest Arc Reactor normalized by body shoulder scale
vec3 nanoRel = (vNanoWorldPos - uNanoOrigin) / max(uBodyScale, 24.0);
float nanoDist = length(vec3(nanoRel.xy, nanoRel.z * 0.18));

// 2. Multi-scale 3D noise locked to armor coordinates (organic liquid tendrils, never flat circles!)
vec3 nanoP = vNanoLocalPos * uNoiseScale;
float nanoFlow = uArmorTime * 0.25 * uDirectionSign;
float nanoN1 = nanoFbm3(nanoP * 2.8 + vec3(0.0, -nanoFlow * 0.45, nanoFlow));
float nanoN2 = nanoFbm3(nanoP * 7.6 + vec3(nanoFlow * 0.8, nanoFlow * 0.4, -nanoFlow));
float nanoGrain = nanoNoise3(nanoP * 28.0);
float nanoBrush = nanoNoise1(vNanoLocalPos.y * 82.0 + vNanoLocalPos.x * 16.0);

vec2 hexData = nanoHex(vNanoLocalPos.xy * (18.0 * uNoiseScale) + vNanoLocalPos.z * 8.0);
float hexGroove = 1.0 - smoothstep(0.015, 0.08, hexData.x);

float nanoWarp =
  (nanoN1 - 0.5) * uWarpStrength +
  (nanoN2 - 0.5) * (uWarpStrength * 0.42) +
  (hexData.y - 0.5) * 0.055;

float nanoGrad = (nanoDist + uGradOffset) - uNanoProgress + nanoWarp;

// Optional independent Mark 85 faceplate dissolve (seals inward from brow & cheeks over real face)
if (uUseVisorMask > 0.5) {
  vec2 vRel = (vNanoWorldPos.xy - uVisorOrigin.xy) / max(uFaceScale, 16.0);
  float vRimDist = clamp(0.92 - length(vRel * vec2(1.05, 0.86)), 0.0, 1.2);
  float vGrad = vRimDist - uVisorProgress + nanoWarp * 0.55;
  nanoGrad = max(nanoGrad, vGrad);
}

// 3. Liquid-Metal Wavefront: SmootherStep(gradient) * 1D Liquid Noise(gradient) -> Negative 3D Bump
float waveSpan = max(uWaveWidth, 0.16);
float bandT = clamp(1.0 - (-nanoGrad / waveSpan), 0.0, 1.0);
float liquidMask = nanoSmootherstep(bandT) * step(nanoGrad, 0.14);

// Flowing concentric liquid-mercury ripples (exact Cartesian Caramel 1D noise setup + organic swirl!)
float phase = uArmorTime * 3.4 * uDirectionSign;
float wave1D = nanoFbm1(nanoGrad * uRippleScale - phase + nanoN1 * 2.1);
float waveFine = nanoNoise1(nanoGrad * (uRippleScale * 2.5) - phase * 1.6 + nanoN2 * 3.0);
float liquidRipple = clamp(wave1D * 0.64 + waveFine * 0.36 + (nanoN2 - 0.5) * 0.24, 0.0, 1.0);

// Micro-plate crystallization seams right behind the molten chrome wave
float plateLock = smoothstep(0.06, 0.42, bandT) * (1.0 - smoothstep(0.58, 0.96, bandT));

// Subtle physical surface micro-bump on settled armor (carbon-hex weave on undersuit, brushed grain on gold)
float settledMicro =
  uIsUndersuit * (-hexGroove * 0.26 - (1.0 - nanoN2) * 0.06) +
  uIsBrushedGold * ((nanoBrush - 0.5) * 0.032) +
  uIsCandyRed * ((nanoGrain - 0.5) * 0.012);

// Negative height recesses the liquid metal in 3D so solid armor looks thicker above it
float nanoHeightNorm =
  -liquidMask * (0.26 + 0.74 * liquidRipple)
  - plateLock * hexGroove * 0.25
  + settledMicro * (1.0 - liquidMask);

float nanoHeightWorld = nanoHeightNorm * max(uBodyScale, 64.0) * uBumpDepth;

// Compute derivatives BEFORE discard so GPU 2x2 pixel quads never glitch on edges!
vec2 nanoDHdxy = vec2(dFdx(nanoHeightWorld), dFdy(nanoHeightWorld));
float nanoHasBump = clamp(liquidMask + plateLock + uIsUndersuit * 0.8 + uIsBrushedGold * 0.5, 0.0, 1.0);

// 4. Organic coalescing liquid-metal precursor droplets right ahead of the advancing front
float waveOnline = smoothstep(-0.35, -0.10, uNanoProgress);
float dropletZone = step(0.0, nanoGrad) * (1.0 - smoothstep(0.01, 0.115, nanoGrad)) * waveOnline;
float dropletVal = nanoN2 * 0.68 + hexData.y * 0.32 - nanoGrad * 5.2;
float nanoDroplet = step(0.54, dropletVal) * dropletZone;

// Crisp Alpha-Clip (zero semi-transparent ghosting — 100% solid metallic presence!)
if (nanoGrad > 0.0 && nanoDroplet < 0.5) {
  discard;
}

// 5. Realistic Molten Gunmetal-Silver Liquid Metal -> Candy Crimson / Champagne Gold transition
float colorT = clamp(1.0 - (-nanoGrad / (waveSpan * 0.76)), 0.0, 1.0);
float nanoLiquidMix = max(smoothstep(0.0, 1.0, pow(max(colorT, 1e-4), 1.18)), nanoDroplet);

// Authentic Infinity War / Blender dark liquid titanium-chrome (deep gunmetal valleys, bright quicksilver ridges)
vec3 darkGunmetal = vec3(0.11, 0.125, 0.145);
vec3 moltenSilver = vec3(0.68, 0.72, 0.77);
vec3 chromeCrest = vec3(0.92, 0.95, 0.99);
vec3 liquidColor = mix(darkGunmetal, moltenSilver, smoothstep(0.12, 0.72, liquidRipple));
liquidColor = mix(liquidColor, chromeCrest, smoothstep(0.68, 0.96, liquidRipple));

// Realistic beveled edge contact darkening + automotive candy-red depth flop!
float edgeGrazing = clamp(abs(vNanoObjNormal.z), 0.0, 1.0);
float bevelAO = mix(0.32, 1.0, smoothstep(0.05, 0.58, edgeGrazing));

vec3 armorAlbedo = diffuseColor.rgb;
if (uIsCandyRed > 0.5) {
  // Two-stage automotive candy-apple crimson: glowing ruby on domes, deep blood-burgundy in curves
  vec3 deepBurgundy = diffuseColor.rgb * vec3(0.34, 0.18, 0.22);
  vec3 richRuby = diffuseColor.rgb * 1.16;
  armorAlbedo = mix(deepBurgundy, richRuby, pow(max(edgeGrazing, 0.02), 0.62));
  armorAlbedo *= 1.0 + (nanoGrain - 0.5) * 0.035;
} else if (uIsBrushedGold > 0.5) {
  // Brushed aerospace titanium-gold with subtle directional machining grain & dark bevel seam
  armorAlbedo *= 1.0 + (nanoBrush - 0.5) * 0.095 + (nanoGrain - 0.5) * 0.035;
  armorAlbedo *= bevelAO;
} else if (uIsUndersuit > 0.5) {
  // Carbon-titanium hexagonal muscle weave with deep shadow grooves
  float ribFlute = 0.9 + 0.1 * sin(vNanoLocalPos.x * 52.0);
  armorAlbedo *= mix(1.08, 0.42, hexGroove) * ribFlute * mix(0.45, 1.0, edgeGrazing);
} else {
  armorAlbedo *= (1.0 + (nanoBrush - 0.5) * 0.07) * bevelAO;
}

diffuseColor.rgb = mix(armorAlbedo, liquidColor, nanoLiquidMix) * uRoomTint;

// Subtle realistic nanite micro-welding energy thread right on the leading 2% edge
float nanoWeldEdge = (smoothstep(-0.026, -0.001, nanoGrad) * step(nanoGrad, 0.004) + nanoDroplet * 0.45) * waveOnline;
float nanoWeldVein = hexGroove * smoothstep(-0.11, -0.005, nanoGrad) * step(nanoGrad, 0.0) * waveOnline;
`;

const FRAG_ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
// Molten chrome is mirror-smooth on ridges (0.05) and liquid-textured in dark troughs (0.34)
float liquidRough = mix(0.34, 0.05, smoothstep(0.18, 0.85, liquidRipple));
float settledRough = roughnessFactor
  + uIsBrushedGold * (nanoBrush - 0.5) * 0.07
  + uIsCandyRed * (nanoGrain - 0.5) * 0.03
  + uIsUndersuit * (hexGroove * 0.24 + (nanoGrain - 0.5) * 0.06);
settledRough = clamp(settledRough, 0.06, 0.78);
roughnessFactor = mix(settledRough, liquidRough, nanoLiquidMix);
`;

const FRAG_METALNESS = /* glsl */ `
#include <metalnessmap_fragment>
float settledMetal = uIsUndersuit > 0.5 ? mix(0.84, 0.45, hexGroove) : metalnessFactor;
metalnessFactor = mix(settledMetal, 1.0, nanoLiquidMix);
`;

const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
if (nanoHasBump > 0.002) {
  normal = nanoPerturbNormal(-vViewPosition, normal, nanoDHdxy, faceDirection);
}
`;

const FRAG_CLEARCOAT_NORMAL = /* glsl */ `
#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
  // Clearcoat ripples when metal is liquid, then cures into mirror-smooth automotive lacquer!
  clearcoatNormal = normalize(mix(clearcoatNormal, normal, clamp(liquidMask * 1.2, 0.0, 1.0)));
#endif
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
// Crisp, realistic pale-cyan Arc Reactor nanite bonding spark right at the advancing liquid rim
vec3 weldColor = vec3(0.45, 0.88, 1.0);
vec3 weldGlow = weldColor * (nanoWeldEdge * 0.95 + nanoWeldVein * 0.28);
totalEmissiveRadiance += weldGlow;

if (uIsEnergy > 0.5) {
  float breath = 0.93 + 0.07 * sin(uArmorTime * 3.1);
  vec3 rtRadiance = vec3(1.55, 2.15, 2.45) * breath;
  totalEmissiveRadiance = mix(weldGlow * 1.3, rtRadiance, 1.0 - nanoLiquidMix * 0.7);
}
`;

function bindNanotechShader(
  material: THREE.MeshPhysicalMaterial,
  shared: NanotechSharedUniforms,
  cfg: RoleConfig,
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNanoOrigin = shared.uNanoOrigin;
    shader.uniforms.uVisorOrigin = shared.uVisorOrigin;
    shader.uniforms.uBodyScale = shared.uBodyScale;
    shader.uniforms.uFaceScale = shared.uFaceScale;
    shader.uniforms.uNanoProgress = shared.uNanoProgress;
    shader.uniforms.uVisorProgress = shared.uVisorProgress;
    shader.uniforms.uArmorTime = shared.uArmorTime;
    shader.uniforms.uRoomTint = shared.uRoomTint;
    shader.uniforms.uWarpStrength = shared.uWarpStrength;
    shader.uniforms.uRippleScale = shared.uRippleScale;
    shader.uniforms.uWaveWidth = shared.uWaveWidth;
    shader.uniforms.uBumpDepth = shared.uBumpDepth;
    shader.uniforms.uDirectionSign = shared.uDirectionSign;

    shader.uniforms.uGradOffset = { value: cfg.gradOffset };
    shader.uniforms.uNoiseScale = { value: cfg.noiseScale };
    shader.uniforms.uUseVisorMask = { value: cfg.useVisorMask ? 1.0 : 0.0 };
    shader.uniforms.uIsCandyRed = { value: cfg.isCandyRed ? 1.0 : 0.0 };
    shader.uniforms.uIsBrushedGold = { value: cfg.isBrushedGold ? 1.0 : 0.0 };
    shader.uniforms.uIsUndersuit = { value: cfg.isUndersuit ? 1.0 : 0.0 };
    shader.uniforms.uIsEnergy = { value: cfg.isEnergy ? 1.0 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_COMMON)
      .replace('#include <begin_vertex>', VERT_BEGIN)
      .replace('#include <project_vertex>', VERT_PROJECT);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_COMMON)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGHNESS)
      .replace('#include <metalnessmap_fragment>', FRAG_METALNESS)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <clearcoat_normal_fragment_maps>', FRAG_CLEARCOAT_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
  };

  material.customProgramCacheKey = () => `mk85-photoreal-v3-${cfg.cacheKey}`;
}

export function createMark85Materials(): Mark85Materials {
  const uniforms: NanotechSharedUniforms = {
    uNanoOrigin: { value: new THREE.Vector3(640, 380, 30) },
    uVisorOrigin: { value: new THREE.Vector3(640, 540, 50) },
    uBodyScale: { value: 220 },
    uFaceScale: { value: 95 },
    uNanoProgress: { value: -0.45 },
    uVisorProgress: { value: 1.9 },
    uArmorTime: { value: 0 },
    uRoomTint: { value: new THREE.Color(1, 1, 1) },
    uWarpStrength: { value: 0.48 },
    uRippleScale: { value: 28.0 },
    uWaveWidth: { value: 0.54 },
    uBumpDepth: { value: 0.062 },
    uDirectionSign: { value: 1.0 },
  };

  // Authentic MCU Mark LXXXV two-stage automotive candy-crimson titanium alloy
  const crimson = new THREE.MeshPhysicalMaterial({
    color: 0x9b151e,
    emissive: 0x0d0102,
    emissiveIntensity: 0.35,
    metalness: 0.92,
    roughness: 0.22,
    clearcoat: 1.0,
    clearcoatRoughness: 0.065,
    reflectivity: 0.95,
    envMapIntensity: 1.38,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(crimson, uniforms, {
    cacheKey: 'crimson',
    gradOffset: 0.0,
    noiseScale: 1.4,
    useVisorMask: false,
    isCandyRed: true,
    isBrushedGold: false,
    isUndersuit: false,
    isEnergy: false,
  });

  // Authentic MCU brushed champagne-bronze gold alloy (Mark 85 biceps, shoulders, thighs, trim)
  const gold = new THREE.MeshPhysicalMaterial({
    color: 0xd1a65e,
    emissive: 0x120a02,
    emissiveIntensity: 0.25,
    metalness: 0.97,
    roughness: 0.19,
    clearcoat: 0.38,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.48,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(gold, uniforms, {
    cacheKey: 'gold',
    gradOffset: 0.025,
    noiseScale: 1.45,
    useVisorMask: false,
    isCandyRed: false,
    isBrushedGold: true,
    isUndersuit: false,
    isEnergy: false,
  });

  // Articulated Mark 85 champagne-gold faceplate mask
  const faceplateGold = new THREE.MeshPhysicalMaterial({
    color: 0xd5ab64,
    emissive: 0x120a02,
    emissiveIntensity: 0.25,
    metalness: 0.98,
    roughness: 0.17,
    clearcoat: 0.42,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.55,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(faceplateGold, uniforms, {
    cacheKey: 'faceplate-gold',
    gradOffset: 0.1,
    noiseScale: 1.8,
    useVisorMask: true,
    isCandyRed: false,
    isBrushedGold: true,
    isUndersuit: false,
    isEnergy: false,
  });

  // Deep gunmetal eye socket & frowning mouth seam inside faceplate (retracts cleanly with mask!)
  const faceplateDark = new THREE.MeshPhysicalMaterial({
    color: 0x181c22,
    metalness: 0.88,
    roughness: 0.34,
    envMapIntensity: 0.85,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(faceplateDark, uniforms, {
    cacheKey: 'faceplate-dark',
    gradOffset: 0.09,
    noiseScale: 1.8,
    useVisorMask: true,
    isCandyRed: false,
    isBrushedGold: false,
    isUndersuit: false,
    isEnergy: false,
  });

  // Glowing white-cyan Iron Man Mark 85 helmet eye lenses
  const faceplateEye = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: 0x9cf4ff,
    emissiveIntensity: 1.8,
    metalness: 0.15,
    roughness: 0.08,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(faceplateEye, uniforms, {
    cacheKey: 'faceplate-eye',
    gradOffset: 0.13,
    noiseScale: 2.0,
    useVisorMask: true,
    isCandyRed: false,
    isBrushedGold: false,
    isUndersuit: false,
    isEnergy: true,
  });

  // Machined gunmetal titanium mechanical trim, joints, ribs & ear pods
  const titanium = new THREE.MeshPhysicalMaterial({
    color: 0x5d6773,
    emissive: 0x05070a,
    emissiveIntensity: 0.2,
    metalness: 0.96,
    roughness: 0.25,
    clearcoat: 0.22,
    clearcoatRoughness: 0.24,
    envMapIntensity: 1.3,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(titanium, uniforms, {
    cacheKey: 'titanium',
    gradOffset: -0.03,
    noiseScale: 1.65,
    useVisorMask: false,
    isCandyRed: false,
    isBrushedGold: false,
    isUndersuit: false,
    isEnergy: false,
  });

  // Dark carbon-titanium hexagonal nanotech under-armor (flows over skin slightly ahead of outer plates!)
  const undersuit = new THREE.MeshPhysicalMaterial({
    color: 0x1d222b,
    emissive: 0x030508,
    emissiveIntensity: 0.15,
    metalness: 0.82,
    roughness: 0.36,
    envMapIntensity: 1.05,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(undersuit, uniforms, {
    cacheKey: 'undersuit',
    gradOffset: -0.15,
    noiseScale: 1.6,
    useVisorMask: false,
    isCandyRed: false,
    isBrushedGold: false,
    isUndersuit: true,
    isEnergy: false,
  });

  // Mark 85 clavicle RT lights, angled lower-pec slits & micro-thruster nodes
  const rtLight = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: 0x96f2ff,
    emissiveIntensity: 1.75,
    metalness: 0.15,
    roughness: 0.1,
    side: THREE.DoubleSide,
  });
  bindNanotechShader(rtLight, uniforms, {
    cacheKey: 'rt-light',
    gradOffset: 0.035,
    noiseScale: 1.9,
    useVisorMask: false,
    isCandyRed: false,
    isBrushedGold: false,
    isUndersuit: false,
    isEnergy: true,
  });

  // Chest Arc Reactor Nano-Unit materials
  const reactorBezel = new THREE.MeshPhysicalMaterial({
    color: 0x677381,
    metalness: 0.97,
    roughness: 0.19,
    clearcoat: 0.45,
    envMapIntensity: 1.45,
    side: THREE.DoubleSide,
  });

  const reactorLattice = new THREE.MeshStandardMaterial({
    color: 0x232b35,
    emissive: 0x0a1c28,
    emissiveIntensity: 0.45,
    metalness: 0.94,
    roughness: 0.25,
    side: THREE.DoubleSide,
  });

  const reactorCore = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xcffaff).multiplyScalar(2.1),
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const allMaterials: THREE.Material[] = [
    crimson,
    gold,
    faceplateGold,
    faceplateDark,
    faceplateEye,
    titanium,
    undersuit,
    rtLight,
    reactorBezel,
    reactorLattice,
    reactorCore,
  ];

  return {
    uniforms,
    crimson,
    gold,
    faceplateGold,
    faceplateDark,
    faceplateEye,
    titanium,
    undersuit,
    rtLight,
    reactorBezel,
    reactorLattice,
    reactorCore,
    allMaterials,
    dispose: () => allMaterials.forEach((m) => m.dispose()),
  };
}
