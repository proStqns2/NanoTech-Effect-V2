import * as THREE from 'three';
import { createOpticalGlowTexture } from './armorTextures';
import type { Mark85Materials } from './nanotechShader';

/**
 * Full-Body Sculpted 3D Iron Man Mark LXXXV (Mark 85) Armor Geometry Builder.
 * Right-handed coordinates: +X right, +Y up, +Z toward camera.
 * Designed for seamless full-body coverage (zero gaps at neck, armpits, elbows, wrists, waist, hips, knees).
 */

type Vec2Tuple = [number, number];

type CurvedPlateOpts = {
  archX?: number;
  archY?: number;
  spanX?: number;
  spanY?: number;
  baseZ?: number;
  thickness?: number;
  bevel?: number;
  ridgeStrength?: number;
  ridgeSharpness?: number;
};

function smooth01(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(edge1 - edge0, 1e-5), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Builds a smooth 3D parametric anatomical armor shell with optional beveled solid metal rim thickness.
 */
function createShell(
  uSegs: number,
  vSegs: number,
  evaluate: (u: number, v: number) => THREE.Vector3,
  rimThickness = 0,
): THREE.BufferGeometry {
  const cols = uSegs + 1;
  const rows = vSegs + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const grid: THREE.Vector3[] = [];

  for (let iv = 0; iv < rows; iv++) {
    const v = iv / vSegs;
    for (let iu = 0; iu < cols; iu++) {
      const u = (iu / uSegs) * 2 - 1;
      const p = evaluate(u, v);
      grid.push(p);
      positions.push(p.x, p.y, p.z);
    }
  }

  for (let iv = 0; iv < vSegs; iv++) {
    for (let iu = 0; iu < uSegs; iu++) {
      const a = iv * cols + iu;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  if (rimThickness > 0.0001) {
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
    tmp.setIndex(indices.slice());
    tmp.computeVertexNormals();
    const norm = tmp.getAttribute('normal');

    const addRim = (loop: number[], flip: boolean) => {
      const start = positions.length / 3;
      for (let i = 0; i < loop.length; i++) {
        const idx = loop[i];
        const p = grid[idx];
        const nx = norm.getX(idx);
        const ny = norm.getY(idx);
        const nz = norm.getZ(idx);
        positions.push(p.x, p.y, p.z);
        positions.push(
          p.x - nx * rimThickness,
          p.y - ny * rimThickness,
          p.z - Math.max(nz, 0.35) * rimThickness,
        );
      }
      for (let i = 0; i < loop.length - 1; i++) {
        const f0 = start + i * 2;
        const b0 = f0 + 1;
        const f1 = f0 + 2;
        const b1 = f0 + 3;
        if (flip) indices.push(f0, f1, b1, f0, b1, b0);
        else indices.push(f0, b1, f1, f0, b0, b1);
      }
    };

    const bot: number[] = [];
    const top: number[] = [];
    for (let iu = 0; iu < cols; iu++) {
      bot.push(iu);
      top.push(vSegs * cols + iu);
    }
    const left: number[] = [];
    const right: number[] = [];
    for (let iv = 0; iv < rows; iv++) {
      left.push(iv * cols);
      right.push(iv * cols + uSegs);
    }
    addRim(bot, false);
    addRim(top, true);
    addRim(left, true);
    addRim(right, false);
    tmp.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function subdivideLargeTris(source: THREE.BufferGeometry, threshold = 0.13): THREE.BufferGeometry {
  const nonIdx = source.index ? source.toNonIndexed() : source;
  const pos = nonIdx.getAttribute('position');
  const out: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const bc = new THREE.Vector3();
  const ca = new THREE.Vector3();

  const emit = (p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3) => {
    out.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
  };

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const maxLen = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (maxLen > threshold) {
      ab.addVectors(a, b).multiplyScalar(0.5);
      bc.addVectors(b, c).multiplyScalar(0.5);
      ca.addVectors(c, a).multiplyScalar(0.5);
      emit(a, ab, ca);
      emit(ab, b, bc);
      emit(ca, bc, c);
      emit(ab, bc, ca);
    } else {
      emit(a, b, c);
    }
  }

  if (nonIdx !== source) nonIdx.dispose();
  const res = new THREE.BufferGeometry();
  res.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return res;
}

/**
 * Extrudes a beveled metallic armor plate and smoothly bends it over a 3D anatomical surface.
 */
function createCurvedPlate(points: Vec2Tuple[], opts: CurvedPlateOpts = {}): THREE.BufferGeometry {
  const {
    archX = 0.27,
    archY = 0.07,
    spanX = 0.56,
    spanY = 0.58,
    baseZ = 0,
    thickness = 0.048,
    bevel = 0.016,
    ridgeStrength = 0,
    ridgeSharpness = 9,
  } = opts;

  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel * 0.9,
    steps: 1,
    curveSegments: 8,
  });

  const sub = subdivideLargeTris(raw);
  raw.dispose();

  const pos = sub.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = THREE.MathUtils.clamp(x / Math.max(spanX, 0.05), -1.12, 1.12);
    const ny = THREE.MathUtils.clamp(y / Math.max(spanY, 0.05), -1.12, 1.12);
    const domeX = Math.cos(nx * Math.PI * 0.44);
    const domeY = Math.cos(ny * Math.PI * 0.35);
    const ridge = ridgeStrength > 0 ? ridgeStrength * Math.exp(-Math.abs(x) * ridgeSharpness) : 0;
    pos.setZ(i, baseZ + z + archX * domeX + archY * domeY + ridge);
  }
  pos.needsUpdate = true;
  sub.computeVertexNormals();
  return sub;
}

function addMirrorPlates(
  parent: THREE.Object3D,
  pts: Vec2Tuple[],
  mat: THREE.Material,
  opts: CurvedPlateOpts,
) {
  const r = new THREE.Mesh(createCurvedPlate(pts, opts), mat);
  const mirrored: Vec2Tuple[] = [...pts].reverse().map(([x, y]) => [-x, y]);
  const l = new THREE.Mesh(createCurvedPlate(mirrored, opts), mat);
  parent.add(r, l);
}

function clipGeometry(
  geo: THREE.BufferGeometry,
  keep: (mid: THREE.Vector3) => boolean,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  if (!idx) return geo.clone();
  const kept: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const m = new THREE.Vector3();

  for (let i = 0; i < idx.count; i += 3) {
    const ia = idx.getX(i);
    const ib = idx.getX(i + 1);
    const ic = idx.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (keep(m)) kept.push(ia, ib, ic);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', pos.clone());
  out.setIndex(kept);
  out.computeVertexNormals();
  return out;
}

function makeReactorKeystone(s: number): THREE.Shape {
  const sh = new THREE.Shape();
  sh.moveTo(-0.34 * s, 0.42 * s);
  sh.quadraticCurveTo(0, 0.49 * s, 0.34 * s, 0.42 * s);
  sh.quadraticCurveTo(0.52 * s, 0.38 * s, 0.47 * s, 0.19 * s);
  sh.lineTo(0.19 * s, -0.37 * s);
  sh.quadraticCurveTo(0.1 * s, -0.5 * s, 0, -0.5 * s);
  sh.quadraticCurveTo(-0.1 * s, -0.5 * s, -0.19 * s, -0.37 * s);
  sh.lineTo(-0.47 * s, 0.19 * s);
  sh.quadraticCurveTo(-0.52 * s, 0.38 * s, -0.34 * s, 0.42 * s);
  sh.closePath();
  return sh;
}

export type ArcReactorRig = {
  group: THREE.Group;
  innerRing: THREE.Mesh;
  corona: THREE.Mesh;
  coronaMat: THREE.MeshBasicMaterial;
  shockwave: THREE.Mesh;
  shockwaveMat: THREE.MeshBasicMaterial;
  touchRing: THREE.Mesh;
  touchRingMat: THREE.MeshBasicMaterial;
  glowTexture: THREE.CanvasTexture;
};

/** Mark LXXXV Chest Arc Reactor Nano-Unit (origin of the full-body liquid-metal nanotech suit). */
export function buildArcReactor(mats: Mark85Materials): ArcReactorRig {
  const group = new THREE.Group();

  const bezel = new THREE.Mesh(
    new THREE.ExtrudeGeometry(makeReactorKeystone(1.1), {
      depth: 0.15,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.055,
      bevelThickness: 0.048,
    }),
    mats.reactorBezel,
  );
  bezel.position.z = -0.05;
  group.add(bezel);

  const housing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(makeReactorKeystone(0.9), {
      depth: 0.065,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.02,
      bevelThickness: 0.02,
    }),
    mats.reactorLattice,
  );
  housing.position.z = 0.1;
  group.add(housing);

  const core = new THREE.Mesh(new THREE.ShapeGeometry(makeReactorKeystone(0.8), 18), mats.reactorCore);
  core.position.z = 0.188;
  group.add(core);

  // Authentic Mark 85 internal segmented crystal lattice frame
  const ringShape = makeReactorKeystone(0.54);
  ringShape.holes.push(makeReactorKeystone(0.42));
  const lattice = new THREE.Mesh(new THREE.ShapeGeometry(ringShape, 14), mats.reactorLattice);
  lattice.position.z = 0.2;
  group.add(lattice);

  [Math.PI * 0.5, Math.PI * 0.15, Math.PI * 0.85, -Math.PI * 0.15, -Math.PI * 0.85, -Math.PI * 0.5].forEach((ang) => {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.038), mats.reactorLattice);
    bar.position.set(Math.cos(ang) * 0.31, Math.sin(ang) * 0.3 + 0.025, 0.202);
    bar.rotation.z = ang;
    group.add(bar);
  });

  const innerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.13, 0.185, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  innerRing.position.set(0, 0.025, 0.208);
  group.add(innerRing);

  const glowTexture = createOpticalGlowTexture();
  const coronaMat = new THREE.MeshBasicMaterial({
    map: glowTexture,
    color: 0x90eeff,
    transparent: true,
    opacity: 0.62,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), coronaMat);
  corona.position.set(0, 0.02, 0.24);
  corona.renderOrder = 25;
  group.add(corona);

  const shockwaveMat = new THREE.MeshBasicMaterial({
    color: 0xaef6ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const shockwave = new THREE.Mesh(new THREE.RingGeometry(0.88, 1.0, 56), shockwaveMat);
  shockwave.position.set(0, 0.02, 0.28);
  shockwave.renderOrder = 26;
  shockwave.visible = false;
  group.add(shockwave);

  const touchRingMat = new THREE.MeshBasicMaterial({
    color: 0xc2f9ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const touchRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.8, 44), touchRingMat);
  touchRing.position.set(0, 0.02, 0.3);
  touchRing.renderOrder = 27;
  touchRing.visible = false;
  group.add(touchRing);

  return { group, innerRing, corona, coronaMat, shockwave, shockwaveMat, touchRing, touchRingMat, glowTexture };
}

/**
 * Full Mark LXXXV Sculpted 3D Torso Cuirass — broad, seamless coverage over real chest, traps, ribs & waist.
 */
export function buildTorso(mats: Mark85Materials): THREE.Group {
  const torso = new THREE.Group();

  // 1. Continuous anatomical carbon-hex nanotech body shell (completely seals chest, ribs, lats & waist!)
  const bodyShell = createShell(32, 24, (u, v) => {
    // v = 0 below waist (-0.54), v = 1 upper traps (+0.58)
    const y = -0.54 + v * 1.12;
    let halfW: number;
    if (v < 0.24) {
      halfW = THREE.MathUtils.lerp(0.41, 0.39, v / 0.24);
    } else if (v < 0.78) {
      const t = (v - 0.24) / 0.54;
      halfW = THREE.MathUtils.lerp(0.39, 0.57, Math.sin(t * Math.PI * 0.5));
    } else {
      const t = (v - 0.78) / 0.22;
      halfW = THREE.MathUtils.lerp(0.57, 0.26, t * t);
    }
    const angle = u * Math.PI * 0.49;
    const x = Math.sin(angle) * halfW;
    const depth =
      THREE.MathUtils.lerp(0.24, 0.32, smooth01(0.32, 0.78, v)) * (1 - 0.2 * smooth01(0.84, 1.0, v));
    const pecContour =
      0.036 *
      Math.exp(-(((v - 0.67) / 0.14) ** 2)) *
      Math.exp(-(((Math.abs(u) - 0.35) / 0.27) ** 2));
    const z = Math.cos(angle) * depth + pecContour;
    return new THREE.Vector3(x, y, z);
  });
  torso.add(new THREE.Mesh(bodyShell, mats.undersuit));

  const c: CurvedPlateOpts = {
    archX: 0.27,
    archY: 0.065,
    spanX: 0.58,
    spanY: 0.58,
    baseZ: 0.035,
    thickness: 0.046,
    bevel: 0.015,
  };

  // 2. Muscular Trapezius & Clavicle Armor Yoke
  addMirrorPlates(
    torso,
    [
      [0.09, 0.44],
      [0.21, 0.59],
      [0.41, 0.54],
      [0.54, 0.45],
      [0.42, 0.365],
      [0.14, 0.365],
    ],
    mats.crimson,
    { ...c, baseZ: 0.05 },
  );

  // Titanium shoulder-clavicle mechanical bridges
  addMirrorPlates(
    torso,
    [
      [0.36, 0.53],
      [0.52, 0.48],
      [0.55, 0.39],
      [0.39, 0.38],
    ],
    mats.titanium,
    { ...c, baseZ: 0.046, thickness: 0.04, bevel: 0.012 },
  );

  // Upper sternum gold-trimmed collar plate above Arc Reactor
  torso.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.14, 0.44],
          [0, 0.395],
          [0.14, 0.44],
          [0.115, 0.32],
          [0, 0.295],
          [-0.115, 0.32],
        ],
        { ...c, baseZ: 0.062, ridgeStrength: 0.018 },
      ),
      mats.crimson,
    ),
  );

  // 3. Broad Sculpted 3D Mark LXXXV Pectoral Cuirass Plates
  addMirrorPlates(
    torso,
    [
      [0.105, 0.355],
      [0.39, 0.385],
      [0.555, 0.32],
      [0.53, 0.13],
      [0.39, 0.015],
      [0.145, 0.005],
      [0.052, 0.088],
      [0.132, 0.245],
    ],
    mats.crimson,
    { ...c, baseZ: 0.072, thickness: 0.056, bevel: 0.019 },
  );

  // Lower sternum sculpted V-plate directly under Arc Reactor
  torso.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.15, 0.015],
          [-0.05, 0.095],
          [0, 0.065],
          [0.05, 0.095],
          [0.15, 0.015],
          [0.13, -0.105],
          [0, -0.145],
          [-0.13, -0.105],
        ],
        { ...c, baseZ: 0.068, ridgeStrength: 0.026, ridgeSharpness: 10 },
      ),
      mats.crimson,
    ),
  );

  // 4. Mark 85 Signature Recessed Clavicle RT Lights (left & right collarbone)
  addMirrorPlates(
    torso,
    [
      [0.205, 0.43],
      [0.315, 0.452],
      [0.326, 0.408],
      [0.216, 0.39],
    ],
    mats.titanium,
    { ...c, baseZ: 0.084, thickness: 0.026, bevel: 0.008 },
  );
  addMirrorPlates(
    torso,
    [
      [0.222, 0.422],
      [0.302, 0.438],
      [0.31, 0.414],
      [0.228, 0.399],
    ],
    mats.rtLight,
    { ...c, baseZ: 0.102, thickness: 0.014, bevel: 0.004 },
  );

  // 5. Mark 85 Signature Angled Lower-Pectoral RT Energy Vents
  addMirrorPlates(
    torso,
    [
      [0.33, 0.06],
      [0.47, 0.135],
      [0.482, 0.112],
      [0.342, 0.038],
    ],
    mats.rtLight,
    { ...c, baseZ: 0.105, thickness: 0.014, bevel: 0.004 },
  );

  // 6. Sculpted Segmented 6-Pack Abdominal Armor
  const abSpecs: [number, number, number, number][] = [
    [-0.085, -0.205, 0.175, 0.16],
    [-0.22, -0.34, 0.16, 0.145],
    [-0.355, -0.485, 0.145, 0.12],
  ];
  abSpecs.forEach(([yTop, yBot, wTop, wBot], row) => {
    addMirrorPlates(
      torso,
      [
        [0.013, yTop - 0.01],
        [wTop, yTop + 0.018],
        [wBot, yBot + 0.012],
        [0.013, yBot - 0.01],
      ],
      mats.crimson,
      { ...c, baseZ: 0.06 - row * 0.004, thickness: 0.044, bevel: 0.014 },
    );
  });

  // 7. Mark 85 Champagne-Gold & Gunmetal Serratus / Oblique Ribcage Plates (covers full flanks!)
  addMirrorPlates(
    torso,
    [
      [0.195, 0.002],
      [0.42, 0.032],
      [0.51, -0.02],
      [0.46, -0.175],
      [0.19, -0.13],
    ],
    mats.gold,
    { ...c, baseZ: 0.046, thickness: 0.04, bevel: 0.012 },
  );
  addMirrorPlates(
    torso,
    [
      [0.18, -0.148],
      [0.445, -0.19],
      [0.415, -0.34],
      [0.165, -0.295],
    ],
    mats.titanium,
    { ...c, baseZ: 0.042, thickness: 0.038, bevel: 0.011 },
  );
  addMirrorPlates(
    torso,
    [
      [0.16, -0.312],
      [0.405, -0.355],
      [0.395, -0.51],
      [0.135, -0.485],
    ],
    mats.crimson,
    { ...c, baseZ: 0.044, thickness: 0.04, bevel: 0.012 },
  );

  return torso;
}

/** Seamless Sculpted Mark LXXXV Neck Column & Throat Gorget. */
export function buildNeck(mats: Mark85Materials): THREE.Group {
  const neck = new THREE.Group();

  const column = createShell(22, 12, (u, v) => {
    const y = -0.55 + v * 1.1;
    const r = THREE.MathUtils.lerp(0.58, 0.44, v);
    const ang = u * Math.PI * 0.5;
    return new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r * 0.76);
  });
  neck.add(new THREE.Mesh(column, mats.undersuit));

  addMirrorPlates(
    neck,
    [
      [0.13, 0.48],
      [0.39, 0.38],
      [0.52, -0.48],
      [0.17, -0.5],
    ],
    mats.crimson,
    { archX: 0.32, archY: 0.03, spanX: 0.58, spanY: 0.58, baseZ: 0.055, thickness: 0.042, bevel: 0.012 },
  );

  neck.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.11, 0.38],
          [0.11, 0.38],
          [0.15, -0.45],
          [0, -0.54],
          [-0.15, -0.45],
        ],
        { archX: 0.34, archY: 0.02, spanX: 0.52, spanY: 0.58, baseZ: 0.065, thickness: 0.04, bevel: 0.011, ridgeStrength: 0.022 },
      ),
      mats.crimson,
    ),
  );

  return neck;
}

export type HelmetRig = {
  group: THREE.Group;
  faceplateGroup: THREE.Group;
};

/**
 * Iconic Photorealistic 3D Iron Man Mark LXXXV Helmet & Articulated Brushed-Gold Faceplate.
 */
export function buildHelmet(mats: Mark85Materials): HelmetRig {
  const group = new THREE.Group();

  // 1. Smooth 3D Crimson Cranium Dome (covers full top of head, hair & temples; open front for visor retract!)
  const rawDome = createShell(32, 20, (u, v) => {
    const phi = v * Math.PI * 0.49;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const theta = u * Math.PI * 0.55;
    const rx = 0.59 * (0.95 + 0.05 * Math.sin(v * Math.PI));
    const y = -0.04 + sp * 0.78;
    const x = Math.sin(theta) * cp * rx;
    const crownRidge = 0.026 * Math.exp(-((u * 6.5) ** 2)) * smooth01(0.25, 0.85, v);
    const z = Math.cos(theta) * cp * 0.48 + crownRidge;
    return new THREE.Vector3(x, y, z);
  });

  const dome = clipGeometry(rawDome, (p) => {
    const ax = Math.abs(p.x);
    if (ax > 0.45) return true;
    const peak = ax < 0.22
      ? THREE.MathUtils.lerp(0.32, 0.5, ax / 0.22)
      : THREE.MathUtils.lerp(0.5, 0.16, (ax - 0.22) / 0.23);
    return p.y >= peak;
  });
  rawDome.dispose();
  group.add(new THREE.Mesh(dome, mats.crimson));

  // Center Mark 85 crimson widow's-peak forehead crest
  group.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.145, 0.66],
          [0, 0.7],
          [0.145, 0.66],
          [0.102, 0.43],
          [0, 0.32],
          [-0.102, 0.43],
        ],
        {
          archX: 0.38,
          archY: 0.1,
          spanX: 0.58,
          spanY: 0.74,
          baseZ: 0.035,
          thickness: 0.042,
          bevel: 0.013,
          ridgeStrength: 0.026,
          ridgeSharpness: 12,
        },
      ),
      mats.crimson,
    ),
  );

  // Crimson lateral cheek/jaw helmet frame
  addMirrorPlates(
    group,
    [
      [0.435, 0.25],
      [0.58, 0.18],
      [0.55, -0.15],
      [0.42, -0.39],
      [0.31, -0.34],
      [0.41, -0.06],
    ],
    mats.crimson,
    { archX: 0.38, archY: 0.09, spanX: 0.6, spanY: 0.68, baseZ: 0.012, thickness: 0.052, bevel: 0.015 },
  );

  // Signature Mark 85 Crimson Chin Block
  group.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.155, -0.37],
          [0.155, -0.37],
          [0.195, -0.475],
          [0.115, -0.57],
          [-0.115, -0.57],
          [-0.195, -0.475],
        ],
        {
          archX: 0.38,
          archY: 0.08,
          spanX: 0.56,
          spanY: 0.7,
          baseZ: 0.048,
          thickness: 0.056,
          bevel: 0.016,
          ridgeStrength: 0.022,
          ridgeSharpness: 9,
        },
      ),
      mats.crimson,
    ),
  );

  // Machined Titanium-Gold Ear Pods
  [-1, 1].forEach((side) => {
    const pod = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 24), mats.titanium);
    outer.rotation.z = Math.PI * 0.5;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.108, 0.086, 20), mats.gold);
    inner.rotation.z = Math.PI * 0.5;
    pod.add(outer, inner);
    pod.position.set(side * 0.565, 0.055, 0.12);
    group.add(pod);
  });

  // 2. Articulated Brushed Champagne-Gold Faceplate (retracts cleanly in nanotech liquid metal!)
  const faceplateGroup = new THREE.Group();
  const mc: CurvedPlateOpts = {
    archX: 0.41,
    archY: 0.105,
    spanX: 0.57,
    spanY: 0.68,
    baseZ: 0.036,
    thickness: 0.046,
    bevel: 0.013,
  };

  // Forehead peaks + fierce overhanging Iron Man brow ridge
  faceplateGroup.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [0, 0.32],
          [0.11, 0.44],
          [0.245, 0.51],
          [0.38, 0.435],
          [0.455, 0.25],
          [0.435, 0.142],
          [0.115, 0.086],
          [0.055, 0.078],
          [0, 0.07],
          [-0.055, 0.078],
          [-0.115, 0.086],
          [-0.435, 0.142],
          [-0.455, 0.25],
          [-0.38, 0.435],
          [-0.245, 0.51],
          [-0.11, 0.44],
        ],
        { ...mc, baseZ: 0.055, thickness: 0.052, ridgeStrength: 0.018, ridgeSharpness: 9 },
      ),
      mats.faceplateGold,
    ),
  );

  // Recessed dark gunmetal eye cavities & mouth seam backing (retracts with faceplate!)
  addMirrorPlates(
    faceplateGroup,
    [
      [0.045, 0.125],
      [0.425, 0.165],
      [0.415, 0.018],
      [0.055, 0.01],
    ],
    mats.faceplateDark,
    { ...mc, baseZ: 0.016, thickness: 0.025, bevel: 0.005 },
  );

  faceplateGroup.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.28, -0.235],
          [0.28, -0.235],
          [0.31, -0.315],
          [-0.31, -0.315],
        ],
        { ...mc, baseZ: 0.018, thickness: 0.024, bevel: 0.004 },
      ),
      mats.faceplateDark,
    ),
  );

  // Fierce Recessed Angled Rectangular Iron Man Eye Lenses
  addMirrorPlates(
    faceplateGroup,
    [
      [0.088, 0.086],
      [0.358, 0.13],
      [0.338, 0.068],
      [0.1, 0.043],
    ],
    mats.faceplateEye,
    { ...mc, baseZ: 0.07, thickness: 0.02, bevel: 0.004 },
  );

  // Sculpted nasal bridge & upper philtrum plate
  faceplateGroup.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.064, 0.085],
          [0.064, 0.085],
          [0.118, -0.14],
          [0.17, -0.256],
          [0.11, -0.248],
          [-0.11, -0.248],
          [-0.17, -0.256],
          [-0.118, -0.14],
        ],
        { ...mc, baseZ: 0.064, thickness: 0.05, bevel: 0.012, ridgeStrength: 0.034, ridgeSharpness: 11 },
      ),
      mats.faceplateGold,
    ),
  );

  // Chiseled angular gold cheekbones
  addMirrorPlates(
    faceplateGroup,
    [
      [0.095, 0.036],
      [0.368, 0.067],
      [0.448, 0.115],
      [0.44, -0.085],
      [0.34, -0.282],
      [0.178, -0.276],
      [0.118, -0.135],
    ],
    mats.faceplateGold,
    { ...mc, baseZ: 0.052, thickness: 0.047, bevel: 0.013 },
  );

  // Lower gold mandible plates & lower lip plate
  addMirrorPlates(
    faceplateGroup,
    [
      [0.138, -0.285],
      [0.33, -0.296],
      [0.36, -0.358],
      [0.205, -0.49],
      [0.156, -0.368],
    ],
    mats.faceplateGold,
    { ...mc, baseZ: 0.048, thickness: 0.045, bevel: 0.012 },
  );
  faceplateGroup.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.128, -0.278],
          [0.128, -0.278],
          [0.152, -0.364],
          [-0.152, -0.364],
        ],
        { ...mc, baseZ: 0.054, thickness: 0.044, bevel: 0.01, ridgeStrength: 0.018 },
      ),
      mats.faceplateGold,
    ),
  );

  group.add(faceplateGroup);
  return { group, faceplateGroup };
}

/** Layered 3D Mark LXXXV Shoulder Pauldron + seamless inner shoulder-socket dome. */
export function buildPauldron(mats: Mark85Materials, side: -1 | 1): THREE.Group {
  const g = new THREE.Group();

  // Inner carbon-hex shoulder ball so zero gap ever shows at the armpit/deltoid joint!
  const socket = new THREE.Mesh(new THREE.SphereGeometry(0.46, 20, 14), mats.undersuit);
  socket.scale.set(1, 0.96, 0.88);
  g.add(socket);

  // Brushed champagne-gold lateral deltoid bell
  const goldBell = createShell(
    20,
    13,
    (u, v) => {
      const y = -0.48 + v * 0.92;
      const r = 0.51 * Math.sin(v * Math.PI * 0.85 + 0.18);
      const ang = u * Math.PI * 0.52;
      return new THREE.Vector3(Math.sin(ang) * r + side * (1 - v) * 0.08, y, Math.cos(ang) * r * 0.94);
    },
    0.042,
  );
  g.add(new THREE.Mesh(goldBell, mats.gold));

  // Overlapping candy-crimson upper pauldron cap
  const redCap = createShell(
    20,
    11,
    (u, v) => {
      const y = 0.01 + v * 0.5;
      const r = 0.55 * (0.64 + 0.36 * Math.cos(v * Math.PI * 0.42));
      const ang = u * Math.PI * 0.48;
      const ridge = 0.032 * Math.exp(-((u * 4.5) ** 2));
      return new THREE.Vector3(
        Math.sin(ang) * r - side * v * 0.1,
        y,
        Math.cos(ang) * r * 0.95 + 0.038 + ridge,
      );
    },
    0.046,
  );
  g.add(new THREE.Mesh(redCap, mats.crimson));

  return g;
}

function makeLimbShell(
  radiusFn: (v: number) => number,
  ridge: number,
  vMin = 0,
  vMax = 1,
  zOff = 0,
  rim = 0.034,
): THREE.BufferGeometry {
  return createShell(
    22,
    15,
    (u, vr) => {
      const v = THREE.MathUtils.lerp(vMin, vMax, vr);
      const y = -0.55 + v * 1.1; // Slight overlap at both joints for 100% gap-free limbs!
      const r = radiusFn(v);
      const ang = u * Math.PI * 0.53;
      const crest = ridge * Math.exp(-((u * 5.0) ** 2)) * Math.sin(vr * Math.PI);
      return new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r * 0.93 + crest + zOff);
    },
    rim,
  );
}

/** Mark LXXXV Upper Arm: sculpted champagne-gold muscular bicep barrel + crimson cuffs. */
export function buildUpperArm(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const r = (v: number) => 0.39 + 0.115 * Math.sin(v * Math.PI) + 0.05 * v;
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 0.94, 0, 0, 1, -0.01, 0), mats.undersuit));
  g.add(new THREE.Mesh(makeLimbShell(r, 0.026, 0.11, 0.89, 0.022, 0.038), mats.gold));
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 1.03, 0.022, 0.01, 0.19, 0.035, 0.032), mats.crimson));
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 1.03, 0.022, 0.82, 0.98, 0.035, 0.032), mats.crimson));
  return g;
}

/** Mark LXXXV Forearm Vambrace: muscular tapered candy-crimson gauntlet + gold wrist collar & weapon pod. */
export function buildForearm(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const r = (v: number) => 0.31 + 0.195 * Math.sin(Math.pow(v, 0.72) * Math.PI * 0.88);
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 0.93, 0, 0, 1, -0.01, 0), mats.undersuit));
  g.add(new THREE.Mesh(makeLimbShell(r, 0.044, 0.03, 0.97, 0.024, 0.04), mats.crimson));
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 1.04, 0.02, 0.0, 0.15, 0.036, 0.03), mats.gold));
  g.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.135, 0.29],
          [0.135, 0.29],
          [0.092, -0.23],
          [-0.092, -0.23],
        ],
        { archX: 0.38, archY: 0.04, spanX: 0.46, spanY: 0.56, baseZ: 0.095, thickness: 0.032, bevel: 0.01, ridgeStrength: 0.024 },
      ),
      mats.titanium,
    ),
  );
  return g;
}

/** Mark LXXXV Thigh Cuisse: heroic tapered crimson thigh with sculpted champagne-gold quadriceps plate. */
export function buildThigh(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const r = (v: number) => 0.37 + 0.165 * Math.pow(v, 0.65) + 0.045 * Math.sin(v * Math.PI);
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 0.94, 0, 0, 1, -0.01, 0), mats.undersuit));
  g.add(new THREE.Mesh(makeLimbShell(r, 0.032, 0.03, 0.97, 0.022, 0.042), mats.crimson));
  g.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.235, 0.37],
          [0, 0.44],
          [0.235, 0.37],
          [0.18, -0.35],
          [0, -0.44],
          [-0.18, -0.35],
        ],
        { archX: 0.42, archY: 0.05, spanX: 0.5, spanY: 0.56, baseZ: 0.06, thickness: 0.042, bevel: 0.014, ridgeStrength: 0.03 },
      ),
      mats.gold,
    ),
  );
  return g;
}

/** Mark LXXXV Shin Greave: sculpted calf/tibia crimson greave + gold ankle cuff. */
export function buildShin(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const r = (v: number) => 0.31 + 0.145 * Math.sin(Math.pow(v, 0.75) * Math.PI) + 0.06 * (1 - smooth01(0, 0.22, v));
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 0.93, 0, 0, 1, -0.01, 0), mats.undersuit));
  g.add(new THREE.Mesh(makeLimbShell(r, 0.054, 0.02, 0.97, 0.024, 0.042), mats.crimson));
  g.add(new THREE.Mesh(makeLimbShell((v) => r(v) * 1.03, 0.03, 0.0, 0.17, 0.034, 0.032), mats.gold));
  return g;
}

/** Mark LXXXV Armored Boot. */
export function buildBoot(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const bootShell = createShell(
    18,
    11,
    (u, v) => {
      const y = -0.52 + v * 1.04;
      const r = THREE.MathUtils.lerp(0.48, 0.36, v);
      const ang = u * Math.PI * 0.52;
      return new THREE.Vector3(Math.sin(ang) * r, y, Math.cos(ang) * r + 0.12 * (1 - v));
    },
    0.042,
  );
  g.add(new THREE.Mesh(bootShell, mats.crimson));
  g.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.38, -0.35],
          [0.38, -0.35],
          [0.44, -0.54],
          [-0.44, -0.54],
        ],
        { archX: 0.4, archY: 0.02, spanX: 0.5, spanY: 0.52, baseZ: 0.12, thickness: 0.042, bevel: 0.012 },
      ),
      mats.titanium,
    ),
  );
  return g;
}

/** Articulated 3D Elbow, Knee & Hip Socket Guard. */
export function buildJoint(mats: Mark85Materials, style: 'elbow' | 'knee' | 'hip'): THREE.Group {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.46, 18, 14),
    style === 'hip' ? mats.undersuit : mats.titanium,
  );
  ball.scale.set(1, 0.92, 0.82);
  g.add(ball);

  if (style !== 'hip') {
    g.add(
      new THREE.Mesh(
        createCurvedPlate(
          [
            [0, 0.47],
            [0.35, 0.17],
            [0.29, -0.35],
            [0, -0.49],
            [-0.29, -0.35],
            [-0.35, 0.17],
          ],
          {
            archX: 0.32,
            archY: 0.12,
            spanX: 0.44,
            spanY: 0.52,
            baseZ: 0.15,
            thickness: 0.06,
            bevel: 0.02,
            ridgeStrength: 0.04,
            ridgeSharpness: 8,
          },
        ),
        style === 'knee' ? mats.gold : mats.crimson,
      ),
    );
  }
  return g;
}

/** Mark LXXXV Pelvis Belt, Codpiece & Hip Tassets (bridges lower abs seamlessly into both thighs!). */
export function buildPelvis(mats: Mark85Materials): THREE.Group {
  const g = new THREE.Group();
  const c: CurvedPlateOpts = {
    archX: 0.27,
    archY: 0.06,
    spanX: 0.58,
    spanY: 0.52,
    baseZ: 0.03,
    thickness: 0.046,
    bevel: 0.015,
  };

  g.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.52, 0.38],
          [0.52, 0.38],
          [0.46, -0.16],
          [0.15, -0.5],
          [-0.15, -0.5],
          [-0.46, -0.16],
        ],
        { ...c, baseZ: 0.0 },
      ),
      mats.undersuit,
    ),
  );

  addMirrorPlates(
    g,
    [
      [0.11, 0.3],
      [0.52, 0.4],
      [0.54, 0.21],
      [0.14, 0.11],
    ],
    mats.gold,
    { ...c, baseZ: 0.058 },
  );

  g.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.16, 0.32],
          [0, 0.25],
          [0.16, 0.32],
          [0.2, -0.09],
          [0.11, -0.5],
          [-0.11, -0.5],
          [-0.2, -0.09],
        ],
        { ...c, baseZ: 0.068, thickness: 0.054, ridgeStrength: 0.034, ridgeSharpness: 9 },
      ),
      mats.crimson,
    ),
  );

  addMirrorPlates(
    g,
    [
      [0.2, 0.11],
      [0.53, 0.19],
      [0.49, -0.25],
      [0.22, -0.35],
    ],
    mats.crimson,
    { ...c, baseZ: 0.05 },
  );

  return g;
}

export type HandRig = {
  gauntlet: THREE.Group;
  fingers: THREE.Mesh[];
  repulsor: THREE.Group;
  repulsorRing: THREE.Mesh;
  repulsorCorona: THREE.Mesh;
  repulsorCoronaMat: THREE.MeshBasicMaterial;
  blastGroup: THREE.Group;
  blastCoreMat: THREE.MeshBasicMaterial;
  blastGlowMat: THREE.MeshBasicMaterial;
  shockRings: THREE.Mesh[];
  shockMats: THREE.MeshBasicMaterial[];
};

export function createFingerGeo(): THREE.BufferGeometry {
  return makeLimbShell((v) => THREE.MathUtils.lerp(0.39, 0.47, v), 0.04, 0, 1, 0.02, 0.02);
}

/** Full 3D Gauntlet, 15 Articulated Finger Segments, Palm Repulsor & MCU Anamorphic Blast. */
export function buildHand(
  mats: Mark85Materials,
  glowTex: THREE.CanvasTexture,
  fingerGeo: THREE.BufferGeometry,
): HandRig {
  const gauntlet = new THREE.Group();

  const shell = createShell(
    16,
    11,
    (u, v) => {
      const y = -0.52 + v * 1.04;
      const w = THREE.MathUtils.lerp(0.44, 0.56, smooth01(0, 0.78, v));
      const ang = u * Math.PI * 0.5;
      return new THREE.Vector3(Math.sin(ang) * w, y, Math.cos(ang) * 0.32);
    },
    0.042,
  );
  gauntlet.add(new THREE.Mesh(shell, mats.crimson));

  gauntlet.add(
    new THREE.Mesh(
      createCurvedPlate(
        [
          [-0.46, 0.47],
          [0, 0.53],
          [0.46, 0.47],
          [0.38, 0.02],
          [0, -0.12],
          [-0.38, 0.02],
        ],
        { archX: 0.28, archY: 0.05, spanX: 0.52, spanY: 0.56, baseZ: 0.082, thickness: 0.042, bevel: 0.014, ridgeStrength: 0.022 },
      ),
      mats.gold,
    ),
  );

  const fingers: THREE.Mesh[] = [];
  for (let i = 0; i < 15; i++) {
    const seg = new THREE.Mesh(fingerGeo, i % 3 === 2 ? mats.gold : mats.crimson);
    seg.visible = false;
    fingers.push(seg);
  }

  const repulsor = new THREE.Group();
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.08, 12, 32), mats.titanium);
  const repulsorRing = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.37, 8),
    new THREE.MeshBasicMaterial({
      color: 0xd2faff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  repulsorRing.position.z = 0.04;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.24, 28), mats.reactorCore);
  disc.position.z = 0.05;

  const repulsorCoronaMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    color: 0x8aeeff,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const repulsorCorona = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), repulsorCoronaMat);
  repulsorCorona.position.z = 0.08;
  repulsorCorona.renderOrder = 28;
  repulsor.add(bezel, repulsorRing, disc, repulsorCorona);

  const blastGroup = new THREE.Group();
  const blastGlowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    color: 0x52dcff,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const blastCoreMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    color: new THREE.Color(0xf4feff).multiplyScalar(2.5),
    transparent: true,
    opacity: 0.98,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const orb = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), blastGlowMat);
  const core = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), blastCoreMat);
  core.position.z = 0.04;
  const flareCore = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 0.24), blastCoreMat);
  flareCore.position.z = 0.05;
  const flareHalo = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 0.7), blastGlowMat);
  flareHalo.position.z = 0.03;
  blastGroup.add(orb, core, flareHalo, flareCore);
  blastGroup.renderOrder = 30;
  blastGroup.visible = false;

  const shockRings: THREE.Mesh[] = [];
  const shockMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 2; i++) {
    const sm = new THREE.MeshBasicMaterial({
      color: 0xc2f9ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const sr = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 48), sm);
    sr.renderOrder = 31;
    sr.visible = false;
    shockRings.push(sr);
    shockMats.push(sm);
  }

  return {
    gauntlet,
    fingers,
    repulsor,
    repulsorRing,
    repulsorCorona,
    repulsorCoronaMat,
    blastGroup,
    blastCoreMat,
    blastGlowMat,
    shockRings,
    shockMats,
  };
}
