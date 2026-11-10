import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Landmark } from './trackingTypes';

export type OverlayOptions = {
  armor: boolean;
  face: boolean;
  body: boolean;
  hands: boolean;
  effects: boolean;
  intensity: number;
};

const armorShell = new THREE.MeshStandardMaterial({
  color: 0xb8343b,
  metalness: 0.95,
  roughness: 0.15,
  emissive: 0x300609,
  emissiveIntensity: 0.5,
  transparent: true,
  opacity: 0.94,
  depthTest: false,
  side: THREE.DoubleSide,
});
const armorGold = new THREE.MeshStandardMaterial({
  color: 0xe1b957,
  metalness: 0.92,
  roughness: 0.16,
  emissive: 0x352005,
  emissiveIntensity: 0.5,
  transparent: true,
  opacity: 0.95,
  depthTest: false,
  side: THREE.DoubleSide,
});
const armorSteel = new THREE.MeshStandardMaterial({
  color: 0x8496a3,
  metalness: 0.9,
  roughness: 0.18,
  emissive: 0x14202a,
  emissiveIntensity: 0.45,
  transparent: true,
  opacity: 0.86,
  depthTest: false,
  side: THREE.DoubleSide,
});
const armorAccent = new THREE.MeshBasicMaterial({
  color: 0x8beeff,
  transparent: true,
  opacity: 0.92,
  depthTest: false,
  side: THREE.DoubleSide,
});
const energyMaterial = new THREE.MeshBasicMaterial({
  color: 0x80eaff,
  transparent: true,
  opacity: 0.94,
  depthTest: false,
});
const lineMaterial = new THREE.LineBasicMaterial({
  color: 0x73ddff,
  transparent: true,
  opacity: 0.83,
  depthTest: false,
});

const pulsingMaterials: THREE.MeshStandardMaterial[] = [];

function addPulsingEmission(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uArmorTime = { value: 0 };
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform float uArmorTime;',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.008, 0.055, 0.075) * (0.55 + 0.45 * sin(uArmorTime * 2.1));',
    );
    material.userData.pulseShader = shader;
  };
  material.customProgramCacheKey = () => 'armor-pulse-emission-v1';
  pulsingMaterials.push(material);
}

addPulsingEmission(armorShell);
addPulsingEmission(armorGold);
addPulsingEmission(armorSteel);

function makeShape(points: [number, number][]) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.035,
    bevelThickness: 0.025,
    depth: 0.055,
    steps: 1,
  });
}

function addPlate(
  parent: THREE.Object3D,
  points: [number, number][],
  material: THREE.Material,
  z: number,
) {
  const mesh = new THREE.Mesh(makeShape(points), material);
  mesh.position.z = z;
  parent.add(mesh);
  return mesh;
}

function addArmorJoint(parent: THREE.Object3D) {
  const joint = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), armorSteel);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 12), armorShell);
  cap.position.z = 0.2;
  joint.add(shell, cap);
  parent.add(joint);
  return joint;
}

function visible(point: Landmark | undefined) {
  return point !== undefined && (point.visibility === undefined || point.visibility > 0.3);
}

function smoothLandmarks(previous: Landmark[], current: Landmark[], amount: number): Landmark[] {
  return current.map((landmark, index) => {
    const last = previous[index];
    if (!last) return landmark;
    const z = landmark.z ?? last.z;
    return {
      ...landmark,
      x: last.x + (landmark.x - last.x) * amount,
      y: last.y + (landmark.y - last.y) * amount,
      z: z === undefined ? undefined : (last.z ?? z) + (z - (last.z ?? z)) * amount,
    };
  });
}

function easeOut(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return 1 - (1 - clamped) ** 3;
}

function createHudTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Le HUD holographique n’a pas pu être initialisé.');

  context.strokeStyle = '#8beeff';
  context.fillStyle = '#8beeff';
  context.lineWidth = 1.2;
  context.globalAlpha = 0.82;
  [42, 63, 91].forEach((radius, index) => {
    context.beginPath();
    context.arc(128, 128, radius, 0.16 + index * 0.32, Math.PI * 1.78 + index * 0.2);
    context.stroke();
  });
  for (let index = 0; index < 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    const innerRadius = index % 4 === 0 ? 99 : 104;
    const outerRadius = 111;
    context.beginPath();
    context.moveTo(128 + Math.cos(angle) * innerRadius, 128 + Math.sin(angle) * innerRadius);
    context.lineTo(128 + Math.cos(angle) * outerRadius, 128 + Math.sin(angle) * outerRadius);
    context.stroke();
  }
  context.font = '9px monospace';
  context.fillText('ARMOR LINK', 92, 24);
  context.fillText('BIOMETRIC', 94, 238);
  context.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

export class ArmorOverlay {
  readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -100, 100);
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly cinematicPass: ShaderPass;
  private readonly environmentMap: THREE.Texture;
  private readonly hudTexture: THREE.CanvasTexture;
  private readonly hudMaterial: THREE.MeshBasicMaterial;
  private readonly faceHud: THREE.Mesh;
  private readonly torso = new THREE.Group();
  private readonly facePlate = new THREE.Group();
  private readonly shoulders: THREE.Mesh[] = [];
  private readonly upperArms: THREE.Mesh[] = [];
  private readonly forearms: THREE.Mesh[] = [];
  private readonly thighs: THREE.Mesh[] = [];
  private readonly shins: THREE.Mesh[] = [];
  private readonly boots: THREE.Mesh[] = [];
  private readonly elbows: THREE.Group[] = [];
  private readonly knees: THREE.Group[] = [];
  private readonly hips: THREE.Group[] = [];
  private readonly gauntlets: THREE.Mesh[] = [];
  private readonly handHuds: THREE.Mesh[] = [];
  private readonly waist = new THREE.Mesh();
  private readonly palms: THREE.Group[] = [];
  private readonly repulsorBolts: THREE.Group[] = [];
  private readonly lastShotAt = [0, 0];
  private readonly previousOpenHands = [false, false];
  private readonly chestCore = new THREE.Group();
  private readonly keyLight = new THREE.PointLight(0xffd2a0, 220, 1100);
  private readonly nanites: THREE.InstancedMesh;
  private readonly naniteDummy = new THREE.Object3D();
  private readonly naniteTargets = Array.from({ length: 13 }, () => ({
    point: new THREE.Vector3(),
    delay: 0,
    active: false,
  }));
  private readonly naniteOrigin = new THREE.Vector3();
  private readonly neckCollar: THREE.Mesh;
  private readonly suitUpDuration = 1900;
  private previousTime = 0;
  private suitUpStartedAt = -1;
  private smoothedPose: Landmark[] = [];
  private smoothedFace: Landmark[] = [];
  private smoothedHands: Landmark[][] = [];
  private width = 1;
  private height = 1;
  private sourceWidth = 1;
  private sourceHeight = 1;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'three-overlay';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    const roomEnvironment = new RoomEnvironment();
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    pmremGenerator.compileEquirectangularShader();
    this.environmentMap = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
    this.scene.environment = this.environmentMap;
    this.scene.environmentIntensity = 1.2;
    pmremGenerator.dispose();
    roomEnvironment.dispose();

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(0.65);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 288), 0.72, 0.34, 0.76);
    this.bloomPass.blendMaterial.blending = THREE.CustomBlending;
    this.bloomPass.blendMaterial.blendEquation = THREE.AddEquation;
    this.bloomPass.blendMaterial.blendSrc = THREE.SrcAlphaFactor;
    this.bloomPass.blendMaterial.blendDst = THREE.OneFactor;
    this.bloomPass.blendMaterial.blendEquationAlpha = THREE.AddEquation;
    this.bloomPass.blendMaterial.blendSrcAlpha = THREE.ZeroFactor;
    this.bloomPass.blendMaterial.blendDstAlpha = THREE.OneFactor;
    this.composer.addPass(this.bloomPass);
    this.cinematicPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        varying vec2 vUv;
        vec3 linearToSrgb(vec3 color) {
          vec3 lower = color * 12.92;
          vec3 upper = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
          return mix(upper, lower, step(color, vec3(0.0031308)));
        }
        void main() {
          vec2 centered = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
          float edge = length(centered);
          vec2 aberration = centered * (0.0012 + edge * 0.0012);
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 chromatic = vec3(
            texture2D(tDiffuse, vUv + aberration).r,
            base.g,
            texture2D(tDiffuse, vUv - aberration).b
          );
          float vignette = 1.0 - smoothstep(0.42, 1.08, edge) * 0.16;
          vec3 linearColor = chromatic * vignette;
          gl_FragColor = vec4(linearToSrgb(linearColor / (linearColor + vec3(1.0))), base.a);
        }
      `,
    });
    this.composer.addPass(this.cinematicPass);

    this.hudTexture = createHudTexture();
    this.hudTexture.colorSpace = THREE.SRGBColorSpace;
    this.hudMaterial = new THREE.MeshBasicMaterial({
      map: this.hudTexture,
      color: 0x9aefff,
      transparent: true,
      opacity: 0.54,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.faceHud = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.hudMaterial);
    this.faceHud.visible = false;
    this.scene.add(this.faceHud);

    const naniteMaterial = new THREE.MeshBasicMaterial({
      color: 0x9af5ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.nanites = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.045, 0), naniteMaterial, 128);
    this.nanites.frustumCulled = false;
    this.nanites.renderOrder = 20;
    this.scene.add(this.nanites);

    const chest = addPlate(
      this.torso,
      [
        [-0.46, 0.45],
        [-0.39, 0.52],
        [0, 0.46],
        [0.39, 0.52],
        [0.46, 0.45],
        [0.34, -0.2],
        [0.22, -0.49],
        [0, -0.55],
        [-0.22, -0.49],
        [-0.34, -0.2],
      ],
      armorShell,
      1,
    );
    chest.material = armorShell;
    const chestLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        [
          [-0.46, 0.45, 0],
          [-0.39, 0.52, 0],
          [0, 0.46, 0],
          [0.39, 0.52, 0],
          [0.46, 0.45, 0],
          [0.34, -0.2, 0],
          [0.22, -0.49, 0],
          [0, -0.55, 0],
          [-0.22, -0.49, 0],
          [-0.34, -0.2, 0],
        ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      ),
      armorGold,
    );
    chestLine.position.z = 2;
    this.torso.add(chestLine);

    const core = new THREE.Mesh(
      new THREE.CircleGeometry(0.13, 36),
      energyMaterial,
    );
    const coreRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.18, 0.025, 8, 48),
      lineMaterial,
    );
    const coreInnerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.1, 0.012, 8, 40),
      armorGold,
    );
    this.chestCore.add(core, coreRing, coreInnerRing);
    this.chestCore.position.z = 4;
    this.torso.add(this.chestCore);
    addPlate(
      this.torso,
      [
        [-0.38, 0.31],
        [-0.3, 0.37],
        [-0.16, -0.02],
        [-0.2, -0.26],
        [-0.33, -0.18],
      ],
      armorGold,
      2,
    );
    addPlate(
      this.torso,
      [
        [0.38, 0.31],
        [0.3, 0.37],
        [0.16, -0.02],
        [0.2, -0.26],
        [0.33, -0.18],
      ],
      armorGold,
      2,
    );
    addPlate(
      this.torso,
      [
        [-0.27, -0.34],
        [0.27, -0.34],
        [0.18, -0.44],
        [-0.18, -0.44],
      ],
      armorSteel,
      2,
    );
    this.scene.add(this.torso);
    this.neckCollar = new THREE.Mesh(
      new THREE.TorusGeometry(0.36, 0.075, 10, 40),
      armorSteel,
    );
    this.neckCollar.name = 'neck-collar';
    this.torso.add(this.neckCollar);

    const shoulderShape: [number, number][] = [
      [-0.5, 0.3],
      [-0.24, 0.5],
      [0.32, 0.4],
      [0.5, -0.06],
      [0.24, -0.43],
      [-0.37, -0.34],
    ];
    for (let index = 0; index < 2; index += 1) {
      const shoulder = addPlate(this.scene, shoulderShape, armorGold, 2);
      this.shoulders.push(shoulder);
    }

    const upperArmShape: [number, number][] = [
      [-0.36, -0.5],
      [0.36, -0.5],
      [0.47, -0.28],
      [0.35, 0.42],
      [0.16, 0.5],
      [-0.16, 0.5],
      [-0.35, 0.35],
      [-0.48, -0.28],
    ];
    const forearmShape: [number, number][] = [
      [-0.32, -0.5],
      [0.32, -0.5],
      [0.45, -0.3],
      [0.34, 0.36],
      [0.18, 0.5],
      [-0.18, 0.5],
      [-0.34, 0.36],
      [-0.45, -0.3],
    ];
    for (let index = 0; index < 2; index += 1) {
      this.upperArms.push(addPlate(this.scene, upperArmShape, armorShell, 3));
      this.forearms.push(addPlate(this.scene, forearmShape, armorShell, 4));
      this.thighs.push(addPlate(this.scene, upperArmShape, armorGold, 2));
      this.shins.push(addPlate(this.scene, forearmShape, armorShell, 3));
      this.boots.push(addPlate(this.scene, forearmShape, armorSteel, 4));
      this.elbows.push(addArmorJoint(this.scene));
      this.knees.push(addArmorJoint(this.scene));
      this.hips.push(addArmorJoint(this.scene));
      const gauntlet = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), armorShell);
      this.scene.add(gauntlet);
      this.gauntlets.push(gauntlet);
    }

    this.waist.geometry = makeShape([
      [-0.5, 0.24],
      [-0.43, 0.4],
      [0.43, 0.4],
      [0.5, 0.24],
      [0.35, -0.32],
      [0, -0.48],
      [-0.35, -0.32],
    ]);
    this.waist.material = armorShell;
    this.scene.add(this.waist);

    const brow = addPlate(
      this.facePlate,
      [
        [-0.49, 0.15],
        [-0.38, 0.42],
        [0, 0.49],
        [0.38, 0.42],
        [0.49, 0.15],
        [0.3, 0.02],
        [-0.3, 0.02],
      ],
      armorGold,
      2,
    );
    const jaw = addPlate(
      this.facePlate,
      [
        [-0.34, -0.16],
        [-0.28, -0.42],
        [0, -0.5],
        [0.28, -0.42],
        [0.34, -0.16],
        [0.2, -0.06],
        [-0.2, -0.06],
      ],
      armorShell,
      2,
    );
    addPlate(
      this.facePlate,
      [
        [-0.38, 0.06],
        [-0.08, 0.12],
        [-0.1, 0.18],
        [-0.42, 0.13],
      ],
      energyMaterial,
      4,
    );
    addPlate(
      this.facePlate,
      [
        [0.38, 0.06],
        [0.08, 0.12],
        [0.1, 0.18],
        [0.42, 0.13],
      ],
      energyMaterial,
      4,
    );
    addPlate(
      this.facePlate,
      [
        [-0.48, 0.2],
        [-0.31, 0.42],
        [-0.22, 0.23],
        [-0.29, -0.02],
      ],
      armorSteel,
      1,
    );
    addPlate(
      this.facePlate,
      [
        [0.48, 0.2],
        [0.31, 0.42],
        [0.22, 0.23],
        [0.29, -0.02],
      ],
      armorSteel,
      1,
    );
    brow.material = armorGold;
    jaw.material = armorShell;
    this.scene.add(this.facePlate);

    for (let index = 0; index < 2; index += 1) {
      const palm = new THREE.Group();
      const outer = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.055, 10, 48), lineMaterial);
      const inner = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 8, 40), energyMaterial);
      const center = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), energyMaterial);
      palm.add(outer, inner, center);
      palm.position.z = 6;
      this.scene.add(palm);
      this.palms.push(palm);

      const handHud = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.hudMaterial);
      handHud.visible = false;
      this.scene.add(handHud);
      this.handHuds.push(handHud);

      const beam = new THREE.Group();
      const glow = addPlate(
        beam,
        [
          [-0.18, 0],
          [0.18, 0],
          [0.34, 1],
          [0, 1.16],
          [-0.34, 1],
        ],
        new THREE.MeshBasicMaterial({
          color: 0x22bfff,
          transparent: true,
          opacity: 0.22,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        }),
        0,
      );
      const bolt = addPlate(
        beam,
        [
          [-0.055, 0],
          [0.055, 0],
          [0.15, 0.94],
          [0, 1.04],
          [-0.15, 0.94],
        ],
        new THREE.MeshBasicMaterial({
          color: 0xc8fbff,
          transparent: true,
          opacity: 0.96,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        }),
        0.2,
      );
      glow.name = 'repulsor-glow';
      bolt.name = 'repulsor-bolt';
      beam.visible = false;
      this.scene.add(beam);
      this.repulsorBolts.push(beam);
    }

    this.scene.add(new THREE.AmbientLight(0xffe6d3, 2.2));
    this.keyLight.position.set(-this.width * 0.5, -this.height * 0.4, 220);
    this.scene.add(this.keyLight);
    const fillLight = new THREE.PointLight(0x66dfff, 160, 900);
    fillLight.position.set(this.width * 0.55, -this.height * 0.2, 180);
    this.scene.add(fillLight);
    const rimLight = new THREE.PointLight(0xe6424f, 130, 800);
    rimLight.position.set(0, this.height * 0.7, 120);
    this.scene.add(rimLight);
  }

  resize(width: number, height: number, sourceWidth = this.sourceWidth, sourceHeight = this.sourceHeight) {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.sourceWidth = Math.max(sourceWidth, 1);
    this.sourceHeight = Math.max(sourceHeight, 1);
    this.camera.left = 0;
    this.camera.right = this.width;
    this.camera.top = 0;
    this.camera.bottom = this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.cinematicPass.uniforms.uResolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.keyLight.position.set(this.width * 0.24, this.height * 0.14, 220);
  }

  private mapPoint(landmark: Landmark) {
    const coverScale = Math.max(this.width / this.sourceWidth, this.height / this.sourceHeight);
    const cropX = (this.sourceWidth * coverScale - this.width) / 2;
    const cropY = (this.sourceHeight * coverScale - this.height) / 2;
    return new THREE.Vector3(
      landmark.x * this.sourceWidth * coverScale - cropX,
      landmark.y * this.sourceHeight * coverScale - cropY,
      1,
    );
  }

  private setNaniteTarget(index: number, landmark: Landmark | undefined, delay: number) {
    const target = this.naniteTargets[index];
    if (!landmark || !visible(landmark)) {
      target.active = false;
      return;
    }

    target.point.copy(this.mapPoint(landmark));
    target.delay = delay;
    target.active = true;
  }

  update(
    pose: Landmark[],
    face: Landmark[],
    hands: Landmark[][],
    openHands: boolean[],
    options: OverlayOptions,
    time: number,
  ) {
    const delta = this.previousTime === 0 ? 1 / 60 : THREE.MathUtils.clamp((time - this.previousTime) / 1000, 0, 0.1);
    this.previousTime = time;
    this.smoothedPose = smoothLandmarks(this.smoothedPose, pose, 1 - Math.exp(-delta / 0.038));
    this.smoothedFace = smoothLandmarks(this.smoothedFace, face, 1 - Math.exp(-delta / 0.055));
    this.smoothedHands = hands.map((hand, index) =>
      smoothLandmarks(this.smoothedHands[index] ?? [], hand, 1 - Math.exp(-delta / 0.032)),
    );
    this.bloomPass.strength = 0.58 * options.intensity;
    pulsingMaterials.forEach((material) => {
      const shader = material.userData.pulseShader;
      if (shader?.uniforms.uArmorTime) shader.uniforms.uArmorTime.value = time * 0.001;
    });

    const currentPose = this.smoothedPose;
    const currentFace = this.smoothedFace;
    const currentHands = this.smoothedHands;
    const point = (landmark: Landmark) => this.mapPoint(landmark);
    const reveal = (delay: number) =>
      this.suitUpStartedAt < 0
        ? 0
        : easeOut((time - this.suitUpStartedAt - delay * this.suitUpDuration) / (this.suitUpDuration * 0.14));

    const leftShoulder = currentPose[11];
    const rightShoulder = currentPose[12];
    const leftHip = currentPose[23];
    const rightHip = currentPose[24];

    const hasShoulders = visible(leftShoulder) && visible(rightShoulder);
    const hasHips = visible(leftHip) && visible(rightHip);
    if (hasShoulders && this.suitUpStartedAt < 0) this.suitUpStartedAt = time;
    this.naniteTargets.forEach((target) => {
      target.active = false;
    });
    this.setNaniteTarget(0, leftShoulder, 0.03);
    this.setNaniteTarget(1, rightShoulder, 0.03);
    this.setNaniteTarget(2, currentPose[13], 0.14);
    this.setNaniteTarget(3, currentPose[14], 0.14);
    this.setNaniteTarget(4, currentPose[15], 0.23);
    this.setNaniteTarget(5, currentPose[16], 0.23);
    this.setNaniteTarget(6, leftHip, 0.34);
    this.setNaniteTarget(7, rightHip, 0.34);
    this.setNaniteTarget(8, currentPose[25], 0.43);
    this.setNaniteTarget(9, currentPose[26], 0.43);
    this.setNaniteTarget(10, currentPose[27], 0.54);
    this.setNaniteTarget(11, currentPose[28], 0.54);
    this.setNaniteTarget(12, currentFace[10], 0.67);

    if (hasShoulders) {
      const shoulderCenter = point(leftShoulder).lerp(point(rightShoulder), 0.5);
      const shoulderWidth = point(leftShoulder).distanceTo(point(rightShoulder));
      const hipCenter = hasHips
        ? point(leftHip).lerp(point(rightHip), 0.5)
        : shoulderCenter.clone().add(new THREE.Vector3(0, shoulderWidth * 1.12, 0));
      const center = shoulderCenter.clone().lerp(hipCenter, 0.48);
      const torsoHeight = shoulderCenter.distanceTo(hipCenter);
      this.naniteOrigin.set(center.x, center.y, 13);
      this.torso.position.set(center.x, center.y, 4);
      const torsoReveal = reveal(0);
      this.torso.visible = options.armor && options.body && torsoReveal > 0;
      this.torso.rotation.z = Math.atan2(
        rightShoulder.y - leftShoulder.y,
        rightShoulder.x - leftShoulder.x,
      );
      this.torso.scale.set(shoulderWidth * 0.95 * torsoReveal, torsoHeight * 1.02 * torsoReveal, 1);
      this.chestCore.position.set(0, 0.02, 4);
      this.chestCore.rotation.z = time * 0.0007;
      this.chestCore.scale.setScalar(1 + Math.sin(time * 0.004) * 0.045);
      this.chestCore.visible = options.armor && options.effects && options.body && torsoReveal > 0.05;

      [leftShoulder, rightShoulder].forEach((shoulder, index) => {
        const target = point(shoulder);
        const plate = this.shoulders[index];
        const shoulderReveal = reveal(0.03);
        plate.visible = options.armor && options.body && shoulderReveal > 0;
        plate.position.set(target.x, target.y, 7);
        plate.scale.set(shoulderWidth * 0.34 * shoulderReveal, shoulderWidth * 0.3 * shoulderReveal, 1);
      });

      const collarReveal = reveal(0.58);
      this.neckCollar.position.set(
        shoulderCenter.x,
        shoulderCenter.y + (hipCenter.y - shoulderCenter.y) * -0.16,
        9,
      );
      this.neckCollar.scale.set(shoulderWidth * 0.44 * collarReveal, shoulderWidth * 0.17 * collarReveal, 1);
      this.neckCollar.visible = options.armor && options.body && collarReveal > 0;

      const waistReveal = reveal(0.34);
      this.waist.visible = options.armor && options.body && hasHips && waistReveal > 0;
      if (hasHips) {
        this.waist.position.set(hipCenter.x, hipCenter.y, 8);
        this.waist.rotation.z = Math.atan2(
          rightHip.y - leftHip.y,
          rightHip.x - leftHip.x,
        );
        this.waist.scale.set(shoulderWidth * 0.56 * waistReveal, torsoHeight * 0.3 * waistReveal, 1);
      }
    } else {
      this.shoulders.forEach((shoulder) => (shoulder.visible = false));
      this.waist.visible = false;
      this.neckCollar.visible = false;
      this.chestCore.visible = false;
    }

    const limbPoints: [number, number, THREE.Mesh, number, number, number][] = [
      [11, 13, this.upperArms[0], 0.4, 1.1, 0.1],
      [12, 14, this.upperArms[1], 0.4, 1.1, 0.1],
      [13, 15, this.forearms[0], 0.42, 1.12, 0.22],
      [14, 16, this.forearms[1], 0.42, 1.12, 0.22],
      [23, 25, this.thighs[0], 0.5, 1.08, 0.34],
      [24, 26, this.thighs[1], 0.5, 1.08, 0.34],
      [25, 27, this.shins[0], 0.43, 1.12, 0.44],
      [26, 28, this.shins[1], 0.43, 1.12, 0.44],
      [27, 31, this.boots[0], 0.58, 1.3, 0.55],
      [28, 32, this.boots[1], 0.58, 1.3, 0.55],
    ];
    limbPoints.forEach(([startIndex, endIndex, plate, widthRatio, lengthRatio, delay]) => {
      const startLandmark = currentPose[startIndex];
      const endLandmark = currentPose[endIndex];
      const stageProgress = reveal(delay);
      plate.visible =
        options.armor && options.body && stageProgress > 0 && visible(startLandmark) && visible(endLandmark);
      if (plate.visible) {
        const start = point(startLandmark);
        const end = point(endLandmark);
        const length = start.distanceTo(end);
        plate.position.copy(start.clone().add(end).multiplyScalar(0.5));
        plate.rotation.z = Math.atan2(end.y - start.y, end.x - start.x) - Math.PI / 2;
        plate.scale.set(length * widthRatio * stageProgress, length * lengthRatio * stageProgress, 1);
      }
    });

    const jointPoints: [number, THREE.Group, number, number][] = [
      [13, this.elbows[0], 11, 0.18],
      [14, this.elbows[1], 11, 0.18],
      [25, this.knees[0], 23, 0.4],
      [26, this.knees[1], 24, 0.4],
      [23, this.hips[0], 24, 0.35],
      [24, this.hips[1], 23, 0.35],
    ];
    jointPoints.forEach(([landmarkIndex, joint, referenceIndex, delay]) => {
      const landmark = currentPose[landmarkIndex];
      const reference = currentPose[referenceIndex];
      const stageProgress = reveal(delay);
      joint.visible =
        options.armor && options.body && stageProgress > 0 && visible(landmark) && visible(reference);
      if (!joint.visible) return;
      const target = point(landmark);
      const referencePoint = point(reference);
      const scale = target.distanceTo(referencePoint) * (landmarkIndex < 20 ? 0.34 : 0.5) * stageProgress;
      joint.position.set(target.x, target.y, landmarkIndex < 20 ? 10 : 8);
      joint.scale.set(scale, scale * 0.78, scale * 0.3);
    });

    const faceTop = currentFace[10];
    const faceBottom = currentFace[152];
    const faceLeft = currentFace[234];
    const faceRight = currentFace[454];
    const faceReveal = reveal(0.67);
    this.facePlate.visible = options.armor && options.face && faceReveal > 0;
    if (visible(faceTop) && visible(faceBottom) && visible(faceLeft) && visible(faceRight)) {
      const topPoint = point(faceTop);
      const bottomPoint = point(faceBottom);
      const leftPoint = point(faceLeft);
      const rightPoint = point(faceRight);
      const faceCenter = topPoint.clone().lerp(bottomPoint, 0.5);
      const faceWidth = leftPoint.distanceTo(rightPoint);
      const faceHeight = topPoint.distanceTo(bottomPoint);
      this.facePlate.position.set(faceCenter.x, faceCenter.y, 10);
      this.facePlate.rotation.z = Math.atan2(
        faceRight.y - faceLeft.y,
        faceRight.x - faceLeft.x,
      );
      this.facePlate.scale.set(faceWidth * 0.9 * faceReveal, faceHeight * 0.76 * faceReveal, 1);
      this.faceHud.visible = options.effects && faceReveal > 0;
      this.faceHud.position.set(faceCenter.x, faceCenter.y - faceHeight * 0.08, 9);
      this.faceHud.rotation.z = this.facePlate.rotation.z;
      this.faceHud.scale.set(faceWidth * 1.48, faceWidth * 1.48, 1);
    } else {
      this.facePlate.visible = false;
      this.faceHud.visible = false;
    }

    this.palms.forEach((palm, index) => {
      const hand = currentHands[index];
      const palmCenter = hand?.[9];
      const hasHand = !!palmCenter && !!hand?.[5] && !!hand[17];
      const isOpen = hasHand && !!openHands[index];
      const handHud = this.handHuds[index];
      handHud.visible = options.effects && options.hands && hasHand;
      this.gauntlets[index].visible = options.armor && options.hands && hasHand && reveal(0.22) > 0;
      palm.visible = options.armor && options.hands && !!palmCenter;
      this.repulsorBolts[index].visible =
        options.armor &&
        options.hands &&
        options.effects &&
        isOpen &&
        time - this.lastShotAt[index] < 280;
      if (!palmCenter || !hand?.[5] || !hand[17]) {
        this.previousOpenHands[index] = false;
        return;
      }
      const center = point(palmCenter);
      const indexTip = point(hand[8]);
      const wrist = point(hand[0]);
      const middleKnuckle = point(hand[9]);
      const handSpan = point(hand[5]).distanceTo(point(hand[17]));
      const wristToPalm = middleKnuckle.clone().sub(wrist);
      const wristToPalmLength = Math.max(wristToPalm.length(), 1);
      const handAngle = Math.atan2(wristToPalm.y, wristToPalm.x) - Math.PI / 2;
      const gloveCenter = wrist.clone().lerp(middleKnuckle, 0.52);
      const gauntlet = this.gauntlets[index];
      gauntlet.position.set(gloveCenter.x, gloveCenter.y, 11);
      gauntlet.rotation.z = handAngle;
      gauntlet.scale.set(handSpan * 0.52, wristToPalmLength * 0.52, 0.75);
      palm.position.set(center.x, center.y, 12);
      palm.scale.setScalar(Math.max(handSpan * 0.27, 8) * options.intensity);
      palm.rotation.z = time * 0.0005;
      handHud.position.set(center.x, center.y, 10);
      handHud.rotation.z = handAngle;
      handHud.scale.setScalar(Math.max(handSpan * 0.9, 12));

      if (options.effects && isOpen && !this.previousOpenHands[index]) {
        this.lastShotAt[index] = time;
        this.suitUpStartedAt = time;
      }
      this.previousOpenHands[index] = isOpen;

      const beam = this.repulsorBolts[index];
      if (beam.visible) {
        const progress = (time - this.lastShotAt[index]) / 280;
        const direction = indexTip.sub(wrist);
        const angle =
          direction.lengthSq() > 0.0001
            ? Math.atan2(direction.y, direction.x) - Math.PI / 2
            : Math.PI;
        beam.position.set(center.x, center.y, 14);
        beam.rotation.z = angle;
        beam.scale.setScalar(Math.max(handSpan * 0.21, 7) * options.intensity);
        beam.scale.y = Math.max(this.height, this.width) * (0.25 + progress * 0.22);
        beam.scale.x = Math.max(handSpan * 0.2, 5) * options.intensity * (1 - progress * 0.42);
      }
    });

    const deploymentActive =
      this.suitUpStartedAt >= 0 && time - this.suitUpStartedAt < this.suitUpDuration * 0.9;
    this.nanites.visible = options.armor && options.effects && deploymentActive;
    for (let index = 0; index < this.nanites.count; index += 1) {
      const target = this.naniteTargets[index % this.naniteTargets.length];
      const progress = target.active
        ? (time - this.suitUpStartedAt - target.delay * this.suitUpDuration) / (this.suitUpDuration * 0.23)
        : -1;
      if (progress < 0 || progress > 1 || !this.nanites.visible) {
        this.naniteDummy.scale.setScalar(0);
      } else {
        const travel = easeOut(progress);
        const fan = Math.sin(progress * Math.PI) * (4 + (index % 7) * 1.3);
        const angle = index * 2.399 + progress * 7;
        this.naniteDummy.position.set(
          this.naniteOrigin.x + (target.point.x - this.naniteOrigin.x) * travel + Math.cos(angle) * fan,
          this.naniteOrigin.y + (target.point.y - this.naniteOrigin.y) * travel + Math.sin(angle) * fan,
          16 + Math.sin(angle * 2) * 0.8,
        );
        this.naniteDummy.rotation.set(angle, angle * 0.7, angle * 1.4);
        this.naniteDummy.scale.setScalar(7 + Math.sin(progress * Math.PI) * 8);
      }
      this.naniteDummy.updateMatrix();
      this.nanites.setMatrixAt(index, this.naniteDummy.matrix);
    }
    this.nanites.instanceMatrix.needsUpdate = true;
    this.composer.render();
  }

  prepareCapture() {
    this.composer.render();
  }

  drawTracking(
    canvas: HTMLCanvasElement,
    options: OverlayOptions,
  ) {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    if (options.body && this.smoothedPose.length > 0) {
      const bones: [number, number][] = [
        [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
        [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
      ];
      context.lineWidth = 1.5;
      context.strokeStyle = 'rgba(107, 218, 255, 0.72)';
      bones.forEach(([start, end]) => {
        if (!visible(this.smoothedPose[start]) || !visible(this.smoothedPose[end])) return;
        context.beginPath();
        const startPoint = this.mapPoint(this.smoothedPose[start]);
        const endPoint = this.mapPoint(this.smoothedPose[end]);
        context.moveTo(startPoint.x, startPoint.y);
        context.lineTo(endPoint.x, endPoint.y);
        context.stroke();
      });
      [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].forEach((index) => {
        const landmark = this.smoothedPose[index];
        if (!visible(landmark)) return;
        const position = this.mapPoint(landmark);
        context.beginPath();
        context.fillStyle = '#baf5ff';
        context.arc(position.x, position.y, 2.5, 0, Math.PI * 2);
        context.fill();
      });
    }

    if (options.face && this.smoothedFace.length > 0) {
      context.beginPath();
      context.strokeStyle = 'rgba(255, 207, 123, 0.72)';
      context.lineWidth = 1.2;
      [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10].forEach(
        (index, pointIndex) => {
          const landmark = this.smoothedFace[index];
          if (!landmark) return;
          const position = this.mapPoint(landmark);
          const x = position.x;
          const y = position.y;
          if (pointIndex === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        },
      );
      context.stroke();
      [33, 263].forEach((index) => {
        const eye = this.smoothedFace[index];
        if (!eye) return;
        const position = this.mapPoint(eye);
        context.beginPath();
        context.strokeStyle = 'rgba(103, 230, 255, 0.7)';
        context.arc(position.x, position.y, 10, 0, Math.PI * 2);
        context.stroke();
      });
    }

    if (options.hands) {
      this.smoothedHands.forEach((hand) => {
        hand.forEach((landmark, index) => {
          if (index % 4 !== 0 && index !== 8 && index !== 12 && index !== 16 && index !== 20) return;
          const position = this.mapPoint(landmark);
          context.beginPath();
          context.fillStyle = index === 0 ? '#80eaff' : 'rgba(179, 242, 255, 0.8)';
          context.arc(position.x, position.y, index === 0 ? 3 : 2, 0, Math.PI * 2);
          context.fill();
        });
      });
    }
  }

  dispose() {
    this.composer.dispose();
    this.bloomPass.dispose();
    this.cinematicPass.material.dispose();
    this.cinematicPass.fsQuad.dispose();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const disposeSceneResources = (scene: THREE.Scene) => {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach((material) => materials.add(material));
      });
    };
    disposeSceneResources(this.scene);
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.hudTexture.dispose();
    this.environmentMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
