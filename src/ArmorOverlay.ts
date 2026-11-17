import * as THREE from 'three';
import {
  buildArcReactor,
  buildBoot,
  buildForearm,
  buildHand,
  buildHelmet,
  buildJoint,
  buildNeck,
  buildPauldron,
  buildPelvis,
  buildShin,
  buildThigh,
  buildTorso,
  buildUpperArm,
  createFingerGeo,
  type ArcReactorRig,
  type HandRig,
  type HelmetRig,
} from './armorGeometry';
import { createStudioArmorEnvironment, WebcamLightProbe } from './armorTextures';
import { createMark85Materials, type Mark85Materials } from './nanotechShader';
import { soundFx } from './soundEffects';
import type { Landmark, SuitPhase, SuitTelemetry, TrackingFrame } from './trackingTypes';

const FINGER_CHAINS: [number, number][][] = [
  [[1, 2], [2, 3], [3, 4]],
  [[5, 6], [6, 7], [7, 8]],
  [[9, 10], [10, 11], [11, 12]],
  [[13, 14], [14, 15], [15, 16]],
  [[17, 18], [18, 19], [19, 20]],
];

const SUIT_MIN_PROGRESS = -0.46;
const SUIT_MAX_PROGRESS = 4.55;
const SUIT_UP_SPEED = 1.48; // ~3.3s cinematic full-body liquid-metal materialization from chest
const SUIT_DOWN_SPEED = 1.85;
const CHEST_HOLD_SEC = 0.62;
const CHEST_COOLDOWN_MS = 1500;
const VISOR_OPEN = -0.36;
const VISOR_CLOSED = 1.85;
const BODY_GRACE_MS = 450;

type CoverTransform = { scale: number; offsetX: number; offsetY: number };

type ScreenPt = { x: number; y: number; z: number; vis: number };

/** Adaptive One-Euro low-pass filter: rock-steady when still, zero lag during fast body movement. */
class OneEuroScalar {
  private x = 0;
  private dx = 0;
  private ready = false;

  constructor(
    private readonly minCutoff = 1.65,
    private readonly beta = 0.042,
    private readonly dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / Math.max(dt, 1 / 240));
  }

  filter(value: number, dt: number): number {
    if (!this.ready || !Number.isFinite(this.x)) {
      this.x = value;
      this.dx = 0;
      this.ready = true;
      return value;
    }
    const rawDx = (value - this.x) / Math.max(dt, 1 / 120);
    const ad = this.alpha(this.dCutoff, dt);
    this.dx = this.dx + ad * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this.alpha(cutoff, dt);
    this.x = this.x + a * (value - this.x);
    return this.x;
  }

  reset() {
    this.ready = false;
  }
}

class PointFilterBank {
  private bank = new Map<number, [OneEuroScalar, OneEuroScalar, OneEuroScalar]>();

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
  ) {}

  update(raw: Landmark[], dt: number): Landmark[] {
    if (raw.length === 0) return [];
    const out: Landmark[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      let f = this.bank.get(i);
      if (!f) {
        f = [
          new OneEuroScalar(this.minCutoff, this.beta),
          new OneEuroScalar(this.minCutoff, this.beta),
          new OneEuroScalar(this.minCutoff * 0.85, this.beta * 0.7),
        ];
        this.bank.set(i, f);
      }
      out[i] = {
        x: f[0].filter(p.x, dt),
        y: f[1].filter(p.y, dt),
        z: f[2].filter(p.z ?? 0, dt),
        visibility: p.visibility,
      };
    }
    return out;
  }

  reset() {
    this.bank.clear();
  }
}

type FullBodyRig = {
  root: THREE.Group;
  reactor: ArcReactorRig;
  torso: THREE.Group;
  pelvis: THREE.Group;
  neck: THREE.Group;
  helmet: HelmetRig;
  pauldronL: THREE.Group;
  pauldronR: THREE.Group;
  upperArmL: THREE.Group;
  upperArmR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  forearmL: THREE.Group;
  forearmR: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  thighL: THREE.Group;
  thighR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  bootL: THREE.Group;
  bootR: THREE.Group;
  hands: [HandRig, HandRig];
  fingerGeo: THREE.BufferGeometry;
};

type PostPipeline = {
  sceneRT: THREE.WebGLRenderTarget;
  brightRT: THREE.WebGLRenderTarget;
  blurART: THREE.WebGLRenderTarget;
  blurBRT: THREE.WebGLRenderTarget;
  postCam: THREE.OrthographicCamera;
  postScene: THREE.Scene;
  quad: THREE.Mesh;
  brightMat: THREE.ShaderMaterial;
  blurMat: THREE.ShaderMaterial;
  compositeMat: THREE.ShaderMaterial;
  dispose: () => void;
};

function createPostPipeline(renderer: THREE.WebGLRenderer, w: number, h: number): PostPipeline {
  const supportsFloatRT =
    renderer.capabilities.isWebGL2 &&
    Boolean(
      renderer.extensions.has('EXT_color_buffer_float') ||
        renderer.extensions.has('EXT_color_buffer_half_float'),
    );
  const rtOpts: THREE.RenderTargetOptions = {
    type: supportsFloatRT ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  };
  const bw = Math.max(2, w >> 1);
  const bh = Math.max(2, h >> 1);

  const sceneRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
  const brightRT = new THREE.WebGLRenderTarget(bw, bh, { ...rtOpts, depthBuffer: false });
  const blurART = new THREE.WebGLRenderTarget(bw, bh, { ...rtOpts, depthBuffer: false });
  const blurBRT = new THREE.WebGLRenderTarget(bw, bh, { ...rtOpts, depthBuffer: false });

  const vs = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // Selective HDR bloom: ONLY genuine emissives (Arc Reactor, eyes, RT slits, repulsors, nanite seam) bloom!
  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tInput: { value: sceneRT.texture },
      uThreshold: { value: 1.08 },
    },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      uniform sampler2D tInput;
      uniform float uThreshold;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tInput, vUv);
        vec3 rgb = c.rgb;
        float br = max(max(rgb.r, rgb.g), rgb.b);
        float knee = 0.42;
        float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
        soft = (soft * soft) / (4.0 * knee + 1e-4);
        float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
        gl_FragColor = vec4(rgb * max(contrib, 0.0), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  const blurMat = new THREE.ShaderMaterial({
    uniforms: {
      tInput: { value: brightRT.texture },
      uStep: { value: new THREE.Vector2(1 / bw, 0) },
    },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      uniform sampler2D tInput;
      uniform vec2 uStep;
      varying vec2 vUv;
      void main() {
        vec3 s = texture2D(tInput, vUv).rgb * 0.227027;
        s += texture2D(tInput, vUv + uStep * 1.384615).rgb * 0.316216;
        s += texture2D(tInput, vUv - uStep * 1.384615).rgb * 0.316216;
        s += texture2D(tInput, vUv + uStep * 3.230769).rgb * 0.070270;
        s += texture2D(tInput, vUv - uStep * 3.230769).rgb * 0.070270;
        gl_FragColor = vec4(s, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  // Single-pass ACES Filmic tone mapping + real-time body contact-shadow grounding + HDR bloom over <video>
  const compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: sceneRT.texture },
      tBloom: { value: blurBRT.texture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uBloomStrength: { value: 0.72 },
    },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform vec2 uTexel;
      uniform float uBloomStrength;
      varying vec2 vUv;

      vec3 acesFilm(vec3 x) {
        const float a = 2.51;
        const float b = 0.03;
        const float c = 2.43;
        const float d = 0.59;
        const float e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }

      vec3 toSrgb(vec3 l) {
        return pow(max(l, vec3(1e-5)), vec3(1.0 / 2.2));
      }

      float solidAt(vec2 uv) {
        return step(0.95, texture2D(tScene, uv).a);
      }

      void main() {
        vec4 scene = texture2D(tScene, vUv);
        vec3 bloom = texture2D(tBloom, vUv).rgb * uBloomStrength;

        // Soft physical ambient-occlusion contact shadow cast by solid metal plates onto user's skin & clothes!
        float shadow = 0.0;
        if (scene.a < 0.96) {
          vec2 r1 = uTexel * 4.5;
          vec2 r2 = uTexel * 10.5;
          float occ =
            solidAt(vUv + vec2(r1.x, 0.0)) +
            solidAt(vUv - vec2(r1.x, 0.0)) +
            solidAt(vUv + vec2(0.0, r1.y)) +
            solidAt(vUv - vec2(0.0, r1.y)) +
            0.65 * solidAt(vUv + vec2(r2.x * 0.7, r2.y * 0.85)) +
            0.65 * solidAt(vUv + vec2(-r2.x * 0.7, r2.y * 0.85)) +
            0.55 * solidAt(vUv + vec2(r2.x * 0.7, -r2.y * 0.6)) +
            0.55 * solidAt(vUv + vec2(-r2.x * 0.7, -r2.y * 0.6));
          shadow = clamp((occ / 6.4) * 0.36 * (1.0 - scene.a), 0.0, 0.32);
        }

        if (scene.a > 0.995) {
          vec3 mapped = toSrgb(acesFilm((scene.rgb + bloom) * 1.05));
          gl_FragColor = vec4(mapped, 1.0);
        } else {
          vec3 baseLinear = scene.a > 1e-3 ? scene.rgb / scene.a : vec3(0.0);
          vec3 basePremul = toSrgb(acesFilm(baseLinear * 1.05)) * scene.a;
          vec3 bloomMapped = toSrgb(acesFilm(bloom * 1.1));
          float outAlpha = clamp(scene.a + shadow, 0.0, 1.0);
          gl_FragColor = vec4(clamp(basePremul + bloomMapped, 0.0, 1.0), outAlpha);
        }
      }
    `,
    depthTest: false,
    depthWrite: false,
    premultipliedAlpha: true,
  });

  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), brightMat);
  quad.frustumCulled = false;
  postScene.add(quad);

  return {
    sceneRT,
    brightRT,
    blurART,
    blurBRT,
    postCam,
    postScene,
    quad,
    brightMat,
    blurMat,
    compositeMat,
    dispose: () => {
      sceneRT.dispose();
      brightRT.dispose();
      blurART.dispose();
      blurBRT.dispose();
      brightMat.dispose();
      blurMat.dispose();
      compositeMat.dispose();
      quad.geometry.dispose();
    },
  };
}

export class ArmorOverlayController {
  private readonly canvas: HTMLCanvasElement;
  private readonly getVideo: () => HTMLVideoElement | null;
  private readonly getFrame: () => TrackingFrame;
  private readonly onTelemetry?: (t: SuitTelemetry) => void;

  private renderer: THREE.WebGLRenderer | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private scene: THREE.Scene | null = null;
  private envTex: THREE.Texture | null = null;
  private mats: Mark85Materials | null = null;
  private rig: FullBodyRig | null = null;
  private post: PostPipeline | null = null;
  private lightProbe = new WebcamLightProbe();

  // Dynamic room-matched 3D lighting rig
  private hemiLight: THREE.HemisphereLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLightLeft: THREE.DirectionalLight | null = null;
  private rimLightRight: THREE.DirectionalLight | null = null;
  private reactorLight: THREE.PointLight | null = null;
  private repulsorLights: [THREE.PointLight, THREE.PointLight] | null = null;

  private width = 1;
  private height = 1;
  private dpr = 1;
  private rafId: number | null = null;
  private lastNow = 0;
  private elapsed = 0;
  private lastTelemPush = 0;

  // One-Euro adaptive landmark filters
  private poseFilter = new PointFilterBank(1.75, 0.045);
  private worldFilter = new PointFilterBank(1.5, 0.035);
  private faceFilter = new PointFilterBank(1.9, 0.052);
  private handFilters = [new PointFilterBank(2.1, 0.06), new PointFilterBank(2.1, 0.06)];
  private lastBodySeenAt = -10000;
  private cachedPose: Landmark[] = [];
  private cachedWorld: Landmark[] = [];
  private cachedFace: Landmark[] = [];
  private cachedHands: Landmark[][] = [];
  private cachedOpen: boolean[] = [];

  // Suit & Visor animation state
  private suitPhase: SuitPhase = 'searching';
  private suitProgress = SUIT_MIN_PROGRESS;
  private visorOpen = false;
  private visorProgress = VISOR_CLOSED;
  private hasAutoEquipped = false;
  private bodyLockTimer = 0;
  private shockwaveTime = -10;
  private chestHold = 0;
  private chestCooldownUntil = 0;
  private palmCharge: [number, number] = [0, 0];
  private palmWasOpen: [boolean, boolean] = [false, false];

  constructor(opts: {
    canvas: HTMLCanvasElement;
    getVideo: () => HTMLVideoElement | null;
    getFrame: () => TrackingFrame;
    onTelemetry?: (t: SuitTelemetry) => void;
  }) {
    this.canvas = opts.canvas;
    this.getVideo = opts.getVideo;
    this.getFrame = opts.getFrame;
    this.onTelemetry = opts.onTelemetry;
    this.init();
  }

  /** Replays the full chest-outward liquid-metal nanotech suit generation on your body! */
  replaySuitUp() {
    this.suitProgress = SUIT_MIN_PROGRESS;
    this.suitPhase = 'equipping';
    this.visorOpen = false;
    this.visorProgress = VISOR_CLOSED;
    this.shockwaveTime = this.elapsed;
    this.hasAutoEquipped = true;
    soundFx.playSuitUp();
    this.emitTelemetry(true);
  }

  /** Toggles between equipping and retracting the suit into the Chest Arc Reactor. */
  toggleSuit() {
    if (this.suitPhase === 'equipped' || this.suitPhase === 'equipping') {
      this.suitPhase = 'retracting';
      this.shockwaveTime = this.elapsed;
      soundFx.playSuitRetract();
    } else {
      if (this.suitProgress < -0.25) this.suitProgress = -0.25;
      this.suitPhase = 'equipping';
      this.shockwaveTime = this.elapsed;
      this.hasAutoEquipped = true;
      soundFx.playSuitUp();
    }
    this.emitTelemetry(true);
  }

  /** Retracts or closes the brushed-gold Mark 85 faceplate over your real face. */
  toggleVisor() {
    this.visorOpen = !this.visorOpen;
    soundFx.playVisorToggle(!this.visorOpen);
    this.emitTelemetry(true);
  }

  private init() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    // High-contrast cinematic studio reflection environment (true metallic highlights & dark contrast ribs)
    this.envTex = createStudioArmorEnvironment(renderer);
    scene.environment = this.envTex;

    const camera = new THREE.OrthographicCamera(0, 1280, 720, 0, -2400, 2400);
    camera.position.set(0, 0, 1200);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    // Physical lighting rig modulated every frame by the user's live room lighting
    this.hemiLight = new THREE.HemisphereLight(0xf2f6ff, 0x261d18, 0.72);
    this.keyLight = new THREE.DirectionalLight(0xfff5e8, 2.55);
    this.keyLight.position.set(-340, 620, 880);
    this.rimLightLeft = new THREE.DirectionalLight(0xbcd8ff, 1.35);
    this.rimLightLeft.position.set(-850, 260, 260);
    this.rimLightRight = new THREE.DirectionalLight(0xffe0b5, 1.25);
    this.rimLightRight.position.set(850, 320, 280);

    this.reactorLight = new THREE.PointLight(0x7beeff, 2.2, 620, 1.45);
    this.repulsorLights = [
      new THREE.PointLight(0x78ecff, 0, 560, 1.4),
      new THREE.PointLight(0x78ecff, 0, 560, 1.4),
    ];

    scene.add(
      this.hemiLight,
      this.keyLight,
      this.rimLightLeft,
      this.rimLightRight,
      this.reactorLight,
      this.repulsorLights[0],
      this.repulsorLights[1],
    );

    const mats = createMark85Materials();
    this.mats = mats;

    const root = new THREE.Group();
    const reactor = buildArcReactor(mats);
    const torso = buildTorso(mats);
    const pelvis = buildPelvis(mats);
    const neck = buildNeck(mats);
    const helmet = buildHelmet(mats);
    const pauldronL = buildPauldron(mats, -1);
    const pauldronR = buildPauldron(mats, 1);
    const upperArmL = buildUpperArm(mats);
    const upperArmR = buildUpperArm(mats);
    const elbowL = buildJoint(mats, 'elbow');
    const elbowR = buildJoint(mats, 'elbow');
    const forearmL = buildForearm(mats);
    const forearmR = buildForearm(mats);
    const hipL = buildJoint(mats, 'hip');
    const hipR = buildJoint(mats, 'hip');
    const thighL = buildThigh(mats);
    const thighR = buildThigh(mats);
    const kneeL = buildJoint(mats, 'knee');
    const kneeR = buildJoint(mats, 'knee');
    const shinL = buildShin(mats);
    const shinR = buildShin(mats);
    const bootL = buildBoot(mats);
    const bootR = buildBoot(mats);
    const fingerGeo = createFingerGeo();
    const hand0 = buildHand(mats, reactor.glowTexture, fingerGeo);
    const hand1 = buildHand(mats, reactor.glowTexture, fingerGeo);

    root.add(
      hipL,
      hipR,
      thighL,
      thighR,
      shinL,
      shinR,
      bootL,
      bootR,
      kneeL,
      kneeR,
      pelvis,
      neck,
      torso,
      reactor.group,
      upperArmL,
      upperArmR,
      pauldronL,
      pauldronR,
      forearmL,
      forearmR,
      elbowL,
      elbowR,
      helmet.group,
    );

    for (const h of [hand0, hand1]) {
      root.add(h.gauntlet, h.repulsor, h.blastGroup);
      h.fingers.forEach((f) => root.add(f));
      h.shockRings.forEach((sr) => root.add(sr));
    }

    root.visible = false;
    scene.add(root);

    this.rig = {
      root,
      reactor,
      torso,
      pelvis,
      neck,
      helmet,
      pauldronL,
      pauldronR,
      upperArmL,
      upperArmR,
      elbowL,
      elbowR,
      forearmL,
      forearmR,
      hipL,
      hipR,
      thighL,
      thighR,
      kneeL,
      kneeR,
      shinL,
      shinR,
      bootL,
      bootR,
      hands: [hand0, hand1],
      fingerGeo,
    };

    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(2, Math.round(rect.width || window.innerWidth || 1280));
    this.height = Math.max(2, Math.round(rect.height || window.innerHeight || 720));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(this.width, this.height, false);
    this.post = createPostPipeline(
      renderer,
      Math.max(2, Math.round(this.width * this.dpr)),
      Math.max(2, Math.round(this.height * this.dpr)),
    );
    this.syncCamera();

    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private syncSize() {
    const renderer = this.renderer;
    if (!renderer) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width));
    const h = Math.max(2, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.width && h === this.height && dpr === this.dpr) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    if (this.post) {
      this.post.sceneRT.setSize(pw, ph);
      this.post.brightRT.setSize(Math.max(2, pw >> 1), Math.max(2, ph >> 1));
      this.post.blurART.setSize(Math.max(2, pw >> 1), Math.max(2, ph >> 1));
      this.post.blurBRT.setSize(Math.max(2, pw >> 1), Math.max(2, ph >> 1));
      this.post.compositeMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
    }
    this.syncCamera();
  }

  private syncCamera() {
    if (!this.camera) return;
    this.camera.left = 0;
    this.camera.right = this.width;
    this.camera.top = this.height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  private getCover(): CoverTransform {
    const v = this.getVideo();
    const vw = v && v.videoWidth > 0 ? v.videoWidth : 1280;
    const vh = v && v.videoHeight > 0 ? v.videoHeight : 720;
    const scale = Math.max(this.width / vw, this.height / vh);
    return {
      scale,
      offsetX: (vw * scale - this.width) * 0.5,
      offsetY: (vh * scale - this.height) * 0.5,
    };
  }

  /** Projects a MediaPipe normalized landmark onto mirrored fullscreen `<video>` pixel space. */
  private proj(lm: Landmark, cover: CoverTransform, bodyScale: number): ScreenPt {
    const v = this.getVideo();
    const vw = v && v.videoWidth > 0 ? v.videoWidth : 1280;
    const vh = v && v.videoHeight > 0 ? v.videoHeight : 720;
    // Mirror horizontally to match CSS scaleX(-1) selfie camera!
    const x = (1 - lm.x) * vw * cover.scale - cover.offsetX;
    const yCss = lm.y * vh * cover.scale - cover.offsetY;
    const y = this.height - yCss;
    const z = THREE.MathUtils.clamp(-(lm.z ?? 0) * bodyScale * 0.34, -240, 240);
    return { x, y, z, vis: lm.visibility ?? 1 };
  }

  private placeLimb(
    obj: THREE.Object3D,
    a: ScreenPt,
    b: ScreenPt,
    widthPx: number,
    zLayer: number,
    depthScale = 0.72,
    lengthMul = 1.12,
  ) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len2D = Math.hypot(dx, dy);
    if (len2D < 5) {
      obj.visible = false;
      return;
    }
    obj.visible = true;
    obj.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5 + zLayer);
    const roll = Math.atan2(dy, dx) - Math.PI * 0.5;
    // Subtle 3D foreshortening tilt when limb points toward camera (e.g. aiming palm repulsor!)
    const pitch = THREE.MathUtils.clamp(-Math.atan2(dz, Math.max(len2D, widthPx * 0.7)) * 0.35, -0.45, 0.45);
    obj.rotation.set(pitch, 0, roll);
    // Keep realistic minimum segment length when pointing arm straight at camera
    const segLen = Math.max(len2D * lengthMul, widthPx * 0.72);
    obj.scale.set(widthPx, segLen, widthPx * depthScale);
  }

  private adaptRoomLighting(now: number, dt: number) {
    const v = this.getVideo();
    if (!v || !this.mats || !this.keyLight || !this.hemiLight) return;
    this.lightProbe.sample(v, now, dt);
    const probe = this.lightProbe;

    // Match key-light direction & exposure to actual room brightness and window/lamp side!
    const exposure = THREE.MathUtils.lerp(0.68, 1.24, probe.luminance);
    this.keyLight.intensity = 2.45 * exposure;
    this.keyLight.color.setRGB(
      THREE.MathUtils.lerp(1, probe.tint.r, 0.72),
      THREE.MathUtils.lerp(1, probe.tint.g, 0.72),
      THREE.MathUtils.lerp(1, probe.tint.b, 0.72),
    );
    // Note: video is mirrored horizontally, so flip dirX to match mirrored screen space!
    this.keyLight.position.set(
      this.width * 0.5 - probe.dirX * this.width * 0.85,
      this.height * 0.55 + probe.dirY * this.height * 0.65,
      860,
    );

    this.hemiLight.intensity = 0.7 * exposure;
    const roomScale = THREE.MathUtils.lerp(0.8, 1.08, probe.luminance);
    this.mats.uniforms.uRoomTint.value.setRGB(
      probe.tint.r * roomScale,
      probe.tint.g * roomScale,
      probe.tint.b * roomScale,
    );
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.elapsed += dt;

    this.syncSize();
    this.adaptRoomLighting(now, dt);

    const frame = this.getFrame();
    const rawPose = frame.pose;
    const hasFreshBody =
      rawPose.length >= 25 &&
      (rawPose[11]?.visibility ?? 0) > 0.32 &&
      (rawPose[12]?.visibility ?? 0) > 0.32;

    if (hasFreshBody) {
      this.lastBodySeenAt = now;
      this.cachedPose = this.poseFilter.update(rawPose, dt);
      this.cachedWorld = frame.worldPose.length >= 25 ? this.worldFilter.update(frame.worldPose, dt) : [];
      this.cachedFace = frame.face.length >= 455 ? this.faceFilter.update(frame.face, dt) : [];
      this.cachedHands = frame.hands.slice(0, 2).map((h, i) => this.handFilters[i].update(h, dt));
      this.cachedOpen = frame.openHands;
    } else if (now - this.lastBodySeenAt > BODY_GRACE_MS) {
      this.poseFilter.reset();
      this.worldFilter.reset();
      this.faceFilter.reset();
      this.handFilters[0].reset();
      this.handFilters[1].reset();
      this.bodyLockTimer = 0;
    }

    const bodyActive = now - this.lastBodySeenAt <= BODY_GRACE_MS && this.cachedPose.length >= 25;

    // Auto-equip full Mark 85 nanotech suit right after locking onto the user's real body!
    if (bodyActive && !this.hasAutoEquipped) {
      this.bodyLockTimer += dt;
      if (this.bodyLockTimer >= 0.32) {
        this.hasAutoEquipped = true;
        this.suitProgress = -0.26;
        this.suitPhase = 'equipping';
        this.visorOpen = false;
        this.visorProgress = VISOR_CLOSED;
        this.shockwaveTime = this.elapsed;
        soundFx.playSuitUp();
      }
    }

    // Advance nanotech suit wavefront
    if (this.suitPhase === 'equipping') {
      const accel = 0.85 + 0.34 * THREE.MathUtils.smoothstep(this.suitProgress, -0.2, 2.2);
      this.suitProgress = Math.min(SUIT_MAX_PROGRESS, this.suitProgress + dt * SUIT_UP_SPEED * accel);
      if (this.suitProgress >= SUIT_MAX_PROGRESS) {
        this.suitPhase = 'equipped';
      }
    } else if (this.suitPhase === 'retracting') {
      this.suitProgress = Math.max(SUIT_MIN_PROGRESS, this.suitProgress - dt * SUIT_DOWN_SPEED);
      if (this.suitProgress <= SUIT_MIN_PROGRESS) {
        this.suitPhase = 'retracted';
      }
    } else if (!bodyActive && !this.hasAutoEquipped) {
      this.suitPhase = 'searching';
    }

    const targetVisor = this.visorOpen ? VISOR_OPEN : VISOR_CLOSED;
    this.visorProgress = THREE.MathUtils.lerp(this.visorProgress, targetVisor, 1 - Math.exp(-dt * 7.2));

    if (this.mats) {
      const u = this.mats.uniforms;
      u.uArmorTime.value = this.elapsed;
      u.uNanoProgress.value = this.suitProgress;
      u.uVisorProgress.value = this.visorProgress;
      u.uDirectionSign.value = this.suitPhase === 'retracting' ? -1 : 1;
    }

    if (this.rig) {
      if (bodyActive) {
        this.rig.root.visible = true;
        this.updateBodyRig(this.cachedPose, this.cachedWorld, this.cachedFace, frame.faceMatrix, this.cachedHands, this.cachedOpen, dt, now);
      } else {
        this.rig.root.visible = false;
      }
    }

    this.renderFrame();
    this.emitTelemetry(false);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private updateBodyRig(
    pose: Landmark[],
    worldPose: Landmark[],
    face: Landmark[],
    faceMatrix: number[] | null,
    hands: Landmark[][],
    openHands: boolean[],
    dt: number,
    now: number,
  ) {
    const rig = this.rig;
    const mats = this.mats;
    if (!rig || !mats) return;

    const cover = this.getCover();
    const shL0 = this.proj(pose[11], cover, 220);
    const shR0 = this.proj(pose[12], cover, 220);
    const shoulder2D = Math.hypot(shL0.x - shR0.x, shL0.y - shR0.y);

    // Compute true 3D body yaw from MediaPipe metric worldLandmarks so turning sideways keeps true armor volume!
    let torsoYaw = 0;
    if (worldPose.length >= 13) {
      const wL = worldPose[11];
      const wR = worldPose[12];
      const wLz = wL.z ?? 0;
      const wRz = wR.z ?? 0;
      const wSpan = Math.max(Math.hypot(wL.x - wR.x, wLz - wRz), 0.18);
      // Mirrored selfie X: positive yaw turns right shoulder toward camera
      torsoYaw = THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp((wLz - wRz) / wSpan, -0.82, 0.82)) * 0.62,
        -0.6,
        0.6,
      );
    } else {
      torsoYaw = THREE.MathUtils.clamp(((pose[11].z ?? 0) - (pose[12].z ?? 0)) * 1.1, -0.55, 0.55);
    }

    // Recover un-foreshortened physical shoulder span so armor never squashes flat when user turns 45°!
    const bodyScale = Math.max(48, shoulder2D / Math.max(Math.cos(torsoYaw), 0.62));

    const shL = this.proj(pose[11], cover, bodyScale);
    const shR = this.proj(pose[12], cover, bodyScale);
    const shMid: ScreenPt = {
      x: (shL.x + shR.x) * 0.5,
      y: (shL.y + shR.y) * 0.5,
      z: (shL.z + shR.z) * 0.5,
      vis: 1,
    };

    // Shoulder axis right vector & perpendicular up vector
    const sdx = shL.x - shR.x; // shL (person's left) is on screen RIGHT in mirrored selfie view
    const sdy = shL.y - shR.y;
    const sLen = Math.max(Math.hypot(sdx, sdy), 1);
    const rx = sdx / sLen;
    const ry = sdy / sLen;
    const ux = -ry;
    const uy = rx;

    // Robust full-body hip anchors: use real tracked hips when clearly visible, smoothly blend with anatomical
    // spine estimate when sitting/standing close to a PC webcam so chest & abs stay 100% full-size!
    const rawHipL = this.proj(pose[23], cover, bodyScale);
    const rawHipR = this.proj(pose[24], cover, bodyScale);
    const hipConf = Math.min(rawHipL.vis, rawHipR.vis);
    const hipInView = rawHipL.y > -bodyScale * 0.35 && rawHipR.y > -bodyScale * 0.35;
    const estSpineLen = bodyScale * 1.48;
    const estHipHalf = bodyScale * 0.39 * Math.cos(torsoYaw);
    const estHipMidX = shMid.x - ux * estSpineLen;
    const estHipMidY = shMid.y - uy * estSpineLen;

    const hipWeight = hipInView ? THREE.MathUtils.smoothstep(hipConf, 0.32, 0.72) : 0;
    const hipL: ScreenPt = {
      x: THREE.MathUtils.lerp(estHipMidX + rx * estHipHalf, rawHipL.x, hipWeight),
      y: THREE.MathUtils.lerp(estHipMidY + ry * estHipHalf, rawHipL.y, hipWeight),
      z: THREE.MathUtils.lerp(shMid.z, rawHipL.z, hipWeight),
      vis: rawHipL.vis,
    };
    const hipR: ScreenPt = {
      x: THREE.MathUtils.lerp(estHipMidX - rx * estHipHalf, rawHipR.x, hipWeight),
      y: THREE.MathUtils.lerp(estHipMidY - ry * estHipHalf, rawHipR.y, hipWeight),
      z: THREE.MathUtils.lerp(shMid.z, rawHipR.z, hipWeight),
      vis: rawHipR.vis,
    };
    const hipMid: ScreenPt = {
      x: (hipL.x + hipR.x) * 0.5,
      y: (hipL.y + hipR.y) * 0.5,
      z: (hipL.z + hipR.z) * 0.5,
      vis: hipConf,
    };

    const spineDx = shMid.x - hipMid.x;
    const spineDy = shMid.y - hipMid.y;
    const rawTorsoLen = Math.hypot(spineDx, spineDy);
    const torsoLen = THREE.MathUtils.clamp(rawTorsoLen, bodyScale * 1.18, bodyScale * 1.95);
    const torsoRoll = Math.atan2(spineDy, spineDx) - Math.PI * 0.5;
    const torsoPitch = THREE.MathUtils.clamp(
      -Math.atan2(shMid.z - hipMid.z, Math.max(torsoLen, 40)) * 0.4,
      -0.32,
      0.32,
    );

    // Broad anatomical Mark 85 torso sizing so 100% of the user's real shoulders, chest, ribs & shirt are armored!
    const torsoW = bodyScale * 1.56;
    const torsoH = torsoLen * 1.24;
    const torsoD = bodyScale * 0.72;
    const torsoCx = THREE.MathUtils.lerp(hipMid.x, shMid.x, 0.56);
    const torsoCy = THREE.MathUtils.lerp(hipMid.y, shMid.y, 0.56);
    const torsoCz = (shMid.z + hipMid.z) * 0.5 + 12;

    rig.torso.visible = true;
    rig.torso.position.set(torsoCx, torsoCy, torsoCz);
    rig.torso.rotation.set(torsoPitch, torsoYaw, torsoRoll);
    rig.torso.scale.set(torsoW, torsoH, torsoD);
    rig.torso.updateMatrixWorld(true);

    // ── Chest Arc Reactor Nano-Unit (exact Cartesian Caramel origin Empty on sternum!) ──
    const reactorWorld = new THREE.Vector3(0, 0.215, 0.505).applyMatrix4(rig.torso.matrixWorld);
    const reactorSize = bodyScale * 0.285;
    rig.reactor.group.visible = true;
    rig.reactor.group.position.copy(reactorWorld);
    rig.reactor.group.rotation.set(torsoPitch, torsoYaw, torsoRoll);
    rig.reactor.group.scale.setScalar(reactorSize);
    rig.reactor.innerRing.rotation.z = this.elapsed * 0.85;

    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 3.4);
    const formingBoost = this.suitPhase === 'equipping' || this.suitPhase === 'retracting' ? 0.35 : 0;
    rig.reactor.coronaMat.opacity = 0.56 + 0.14 * pulse + formingBoost;
    rig.reactor.corona.scale.setScalar(0.95 + 0.1 * pulse + formingBoost * 0.35);

    const swAge = this.elapsed - this.shockwaveTime;
    if (swAge >= 0 && swAge < 0.72) {
      const t = swAge / 0.72;
      rig.reactor.shockwave.visible = true;
      rig.reactor.shockwave.scale.setScalar(0.55 + Math.pow(t, 0.52) * 5.6);
      rig.reactor.shockwaveMat.opacity = (1 - t) * (1 - t) * 0.82;
    } else {
      rig.reactor.shockwave.visible = false;
    }

    mats.uniforms.uNanoOrigin.value.copy(reactorWorld);
    mats.uniforms.uBodyScale.value = bodyScale;

    if (this.reactorLight) {
      this.reactorLight.position.set(reactorWorld.x, reactorWorld.y, reactorWorld.z + bodyScale * 0.45);
      this.reactorLight.distance = bodyScale * 3.4;
      this.reactorLight.intensity = 2.1 + pulse * 0.55 + formingBoost * 1.8;
    }

    // ── Pelvis Belt, Codpiece & Hip Sockets (seamless bridge from abs to thighs) ──
    const showPelvis = hipConf > 0.28 || hipMid.y > -bodyScale * 0.45;
    rig.pelvis.visible = showPelvis;
    if (showPelvis) {
      const pelvisW = Math.max(Math.hypot(hipL.x - hipR.x, hipL.y - hipR.y) * 1.58, bodyScale * 1.24);
      rig.pelvis.position.set(
        hipMid.x - ux * bodyScale * 0.04,
        hipMid.y - uy * bodyScale * 0.04,
        hipMid.z + 8,
      );
      rig.pelvis.rotation.set(torsoPitch * 0.6, torsoYaw * 0.85, torsoRoll);
      rig.pelvis.scale.set(pelvisW, bodyScale * 0.72, bodyScale * 0.62);
    }

    // ── 3D Helmet & Neck Tracking (478 Face Mesh + rigid matrix + Pose fallback) ──
    const headBase = this.updateHelmet(pose, face, faceMatrix, cover, bodyScale, torsoYaw, torsoRoll, ux, uy, shMid);
    const neckStart: ScreenPt = {
      x: shMid.x + ux * bodyScale * 0.02,
      y: shMid.y + uy * bodyScale * 0.02,
      z: shMid.z + 6,
      vis: 1,
    };
    if (headBase) {
      this.placeLimb(rig.neck, neckStart, headBase, bodyScale * 0.68, 4, 0.72, 1.32);
    } else {
      rig.neck.visible = false;
    }

    // ── Layered Mark LXXXV Shoulder Pauldrons, Gold Biceps, Elbows & Crimson Forearms ──
    const armConfigs = [
      {
        side: 1, // person's left -> screen right
        sh: shL,
        elIdx: 13,
        wrIdx: 15,
        pauldron: rig.pauldronL,
        upper: rig.upperArmL,
        elbow: rig.elbowL,
        fore: rig.forearmL,
      },
      {
        side: -1, // person's right -> screen left
        sh: shR,
        elIdx: 14,
        wrIdx: 16,
        pauldron: rig.pauldronR,
        upper: rig.upperArmR,
        elbow: rig.elbowR,
        fore: rig.forearmR,
      },
    ] as const;

    const trackedWrists: [ScreenPt | null, ScreenPt | null] = [null, null];

    for (let ai = 0; ai < armConfigs.length; ai++) {
      const a = armConfigs[ai];
      const elRaw = pose[a.elIdx];
      const wrRaw = pose[a.wrIdx];
      const elOk = elRaw && (elRaw.visibility ?? 0) > 0.25;
      const wrOk = wrRaw && (wrRaw.visibility ?? 0) > 0.25;

      const el = elOk ? this.proj(elRaw, cover, bodyScale) : null;
      const wr = wrOk ? this.proj(wrRaw, cover, bodyScale) : null;
      trackedWrists[ai] = wr;

      // Shoulder pauldron wraps outer deltoid and fuses seamlessly into chest cuirass
      a.pauldron.visible = true;
      const pRoll = el
        ? Math.atan2(a.sh.y - el.y, a.sh.x - el.x) - Math.PI * 0.5
        : torsoRoll - a.side * 0.22;
      a.pauldron.position.set(
        a.sh.x + a.side * rx * bodyScale * 0.08 + ux * bodyScale * 0.03,
        a.sh.y + a.side * ry * bodyScale * 0.08 + uy * bodyScale * 0.03,
        a.sh.z + 24,
      );
      a.pauldron.rotation.set(0, torsoYaw * 0.55, pRoll);
      a.pauldron.scale.set(bodyScale * 0.68, bodyScale * 0.64, bodyScale * 0.58);

      if (el) {
        this.placeLimb(a.upper, el, a.sh, bodyScale * 0.58, 15, 0.76, 1.15);
      } else {
        a.upper.visible = false;
      }

      if (el && wr) {
        this.placeLimb(a.fore, wr, el, bodyScale * 0.53, 28, 0.76, 1.14);
        const fRoll = Math.atan2(el.y - wr.y, el.x - wr.x) - Math.PI * 0.5;
        a.elbow.visible = true;
        a.elbow.position.set(el.x, el.y, el.z + 32);
        a.elbow.rotation.set(0, 0, fRoll);
        a.elbow.scale.setScalar(bodyScale * 0.34);
      } else {
        a.fore.visible = false;
        a.elbow.visible = false;
      }
    }

    // ── Full-Body Mark LXXXV Legs: Hip Sockets, Thighs, Knee Cops, Shin Greaves & Armored Boots ──
    const legConfigs = [
      {
        hip: hipL,
        knIdx: 25,
        anIdx: 27,
        ftIdx: 31,
        hipSocket: rig.hipL,
        thigh: rig.thighL,
        knee: rig.kneeL,
        shin: rig.shinL,
        boot: rig.bootL,
      },
      {
        hip: hipR,
        knIdx: 26,
        anIdx: 28,
        ftIdx: 32,
        hipSocket: rig.hipR,
        thigh: rig.thighR,
        knee: rig.kneeR,
        shin: rig.shinR,
        boot: rig.bootR,
      },
    ] as const;

    for (const l of legConfigs) {
      const knRaw = pose[l.knIdx];
      const anRaw = pose[l.anIdx];
      const ftRaw = pose[l.ftIdx];
      const kn = knRaw && (knRaw.visibility ?? 0) > 0.28 ? this.proj(knRaw, cover, bodyScale) : null;
      const an = anRaw && (anRaw.visibility ?? 0) > 0.28 ? this.proj(anRaw, cover, bodyScale) : null;
      const ft = ftRaw && (ftRaw.visibility ?? 0) > 0.28 ? this.proj(ftRaw, cover, bodyScale) : null;

      if (kn && l.hip.vis > 0.28) {
        l.hipSocket.visible = true;
        l.hipSocket.position.set(l.hip.x, l.hip.y, l.hip.z + 4);
        l.hipSocket.scale.setScalar(bodyScale * 0.44);
        this.placeLimb(l.thigh, kn, l.hip, bodyScale * 0.68, 6, 0.74, 1.15);
      } else {
        l.hipSocket.visible = false;
        l.thigh.visible = false;
      }

      if (kn && an) {
        this.placeLimb(l.shin, an, kn, bodyScale * 0.58, 10, 0.74, 1.14);
        const sRoll = Math.atan2(kn.y - an.y, kn.x - an.x) - Math.PI * 0.5;
        l.knee.visible = true;
        l.knee.position.set(kn.x, kn.y, kn.z + 18);
        l.knee.rotation.set(0, 0, sRoll);
        l.knee.scale.setScalar(bodyScale * 0.39);

        if (ft) {
          this.placeLimb(l.boot, ft, an, bodyScale * 0.48, 14, 0.82, 1.24);
        } else {
          // Grounded ankle-boot cap even when toes clip bottom of screen
          const bootTip: ScreenPt = { x: an.x, y: an.y - bodyScale * 0.28, z: an.z + 8, vis: 1 };
          this.placeLimb(l.boot, bootTip, an, bodyScale * 0.46, 14, 0.8, 1.1);
        }
      } else {
        l.shin.visible = false;
        l.knee.visible = false;
        l.boot.visible = false;
      }
    }

    // ── Articulated 3D Gauntlets, 30 Fingers, Palm Repulsors & Fallback Wrist Gauntlets ──
    const palmCenters: ScreenPt[] = [];
    this.updateHands(hands, openHands, trackedWrists, pose, cover, bodyScale, dt, palmCenters);

    // ── Tactile Chest Arc Reactor Double-Tap / Hold Trigger (like Tony Stark in Infinity War!) ──
    const touchSources = [
      ...palmCenters,
      ...(trackedWrists.filter((w): w is ScreenPt => w !== null)),
    ];
    let nearReactor = false;
    const hitRadius = bodyScale * 0.42;
    for (const p of touchSources) {
      if (Math.hypot(p.x - reactorWorld.x, p.y - reactorWorld.y) < hitRadius) {
        nearReactor = true;
        break;
      }
    }

    if (nearReactor && now >= this.chestCooldownUntil && this.suitPhase !== 'equipping' && this.suitPhase !== 'retracting') {
      this.chestHold = Math.min(1, this.chestHold + dt / CHEST_HOLD_SEC);
      rig.reactor.touchRing.visible = true;
      rig.reactor.touchRing.scale.setScalar(0.9 + this.chestHold * 0.72);
      rig.reactor.touchRingMat.opacity = 0.25 + this.chestHold * 0.7;
      if (this.chestHold >= 1) {
        this.chestHold = 0;
        this.chestCooldownUntil = now + CHEST_COOLDOWN_MS;
        rig.reactor.touchRing.visible = false;
        this.toggleSuit();
      }
    } else {
      this.chestHold = Math.max(0, this.chestHold - dt * 3.0);
      rig.reactor.touchRing.visible = this.chestHold > 0.04;
      rig.reactor.touchRingMat.opacity = this.chestHold * 0.55;
    }
  }

  private updateHelmet(
    pose: Landmark[],
    face: Landmark[],
    faceMatrix: number[] | null,
    cover: CoverTransform,
    bodyScale: number,
    torsoYaw: number,
    torsoRoll: number,
    ux: number,
    uy: number,
    shMid: ScreenPt,
  ): ScreenPt | null {
    const rig = this.rig;
    const mats = this.mats;
    if (!rig || !mats) return null;

    // Case 1: High-precision 478 Face Landmarks + optional rigid 4x4 facialTransformationMatrix
    if (face.length >= 455) {
      const forehead = this.proj(face[10], cover, bodyScale);
      const chin = this.proj(face[152], cover, bodyScale);
      const cheekA = this.proj(face[234], cover, bodyScale);
      const cheekB = this.proj(face[454], cover, bodyScale);
      const brow = this.proj(face[168], cover, bodyScale);
      const nose = this.proj(face[1], cover, bodyScale);

      const cheekSpan = Math.hypot(cheekA.x - cheekB.x, cheekA.y - cheekB.y);
      const faceSpanY = Math.hypot(forehead.x - chin.x, forehead.y - chin.y);

      if (cheekSpan > 14 && faceSpanY > 16) {
        let roll = Math.atan2(forehead.y - chin.y, forehead.x - chin.x) - Math.PI * 0.5;
        const cheekMidX = (cheekA.x + cheekB.x) * 0.5;
        let yaw = THREE.MathUtils.clamp(((nose.x - cheekMidX) / Math.max(cheekSpan * 0.5, 1)) * 0.72, -0.72, 0.72);
        let pitch = THREE.MathUtils.clamp(
          -((brow.y - (forehead.y + chin.y) * 0.5) / Math.max(faceSpanY, 1) - 0.08) * 1.1,
          -0.44,
          0.44,
        );

        // Blend with MediaPipe's rigid 3D facial transformation matrix for rock-steady 3D head orientation
        if (faceMatrix && faceMatrix.length === 16) {
          const m = new THREE.Matrix4().fromArray(faceMatrix);
          const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
          if (Number.isFinite(e.x) && Number.isFinite(e.y)) {
            yaw = THREE.MathUtils.lerp(yaw, THREE.MathUtils.clamp(-e.y * 0.82, -0.78, 0.78), 0.5);
            pitch = THREE.MathUtils.lerp(pitch, THREE.MathUtils.clamp(e.x * 0.72, -0.46, 0.46), 0.45);
          }
        }

        // Un-foreshorten helmet width so it wraps the ENTIRE skull, hair, cheeks & jaw with zero skin poking out!
        const trueFaceW = cheekSpan / Math.max(Math.cos(yaw), 0.64);
        const helmW = Math.max(trueFaceW * 1.24, bodyScale * 0.68);
        const helmH = Math.max(faceSpanY * 1.28, helmW * 1.12);
        const helmD = helmW * 0.92;

        // Center helmet so glowing Iron Man eye lenses align directly with the user's real eyes!
        const upX = -Math.sin(roll);
        const upY = Math.cos(roll);
        const cx = (cheekMidX + brow.x) * 0.5 + upX * helmH * 0.025;
        const cy = (forehead.y + chin.y) * 0.5 + upY * helmH * 0.035;
        const cz = (nose.z + cheekA.z + cheekB.z) / 3 + 38;

        rig.helmet.group.visible = true;
        rig.helmet.group.position.set(cx, cy, cz);
        rig.helmet.group.rotation.set(pitch, yaw, roll);
        rig.helmet.group.scale.set(helmW, helmH, helmD);

        mats.uniforms.uVisorOrigin.value.set(cx, cy, cz + 25);
        mats.uniforms.uFaceScale.value = helmW * 0.62;

        return {
          x: chin.x - upX * helmH * 0.03,
          y: chin.y - upY * helmH * 0.03,
          z: cz - 14,
          vis: 1,
        };
      }
    }

    // Case 2: Seamless Pose-Landmark Helmet Fallback (when standing far back for full-body shot or sharp head turn!)
    const noseLm = pose[0];
    const earL = pose[7];
    const earR = pose[8];
    if (noseLm && (noseLm.visibility ?? 0) > 0.35) {
      const nose = this.proj(noseLm, cover, bodyScale);
      let cx = nose.x;
      let cy = nose.y + bodyScale * 0.07;
      let roll = torsoRoll;
      let helmW = bodyScale * 0.72;

      if (earL && earR && (earL.visibility ?? 0) > 0.3 && (earR.visibility ?? 0) > 0.3) {
        const pEL = this.proj(earL, cover, bodyScale);
        const pER = this.proj(earR, cover, bodyScale);
        const earSpan = Math.hypot(pEL.x - pER.x, pEL.y - pER.y);
        cx = (pEL.x + pER.x + nose.x) / 3;
        cy = (pEL.y + pER.y) * 0.5 + bodyScale * 0.06;
        roll = Math.atan2(pEL.y - pER.y, pEL.x - pER.x);
        helmW = THREE.MathUtils.clamp(earSpan * 1.48, bodyScale * 0.66, bodyScale * 0.92);
      }

      const helmH = helmW * 1.18;
      const cz = nose.z + 36;
      rig.helmet.group.visible = true;
      rig.helmet.group.position.set(cx, cy, cz);
      rig.helmet.group.rotation.set(0, torsoYaw * 0.85, roll);
      rig.helmet.group.scale.set(helmW, helmH, helmW * 0.9);

      mats.uniforms.uVisorOrigin.value.set(cx, cy, cz + 25);
      mats.uniforms.uFaceScale.value = helmW * 0.62;

      return {
        x: cx - ux * helmH * 0.42,
        y: cy - uy * helmH * 0.42,
        z: cz - 14,
        vis: 1,
      };
    }

    rig.helmet.group.visible = false;
    return null;
  }

  private updateHands(
    hands: Landmark[][],
    openHands: boolean[],
    trackedWrists: [ScreenPt | null, ScreenPt | null],
    pose: Landmark[],
    cover: CoverTransform,
    bodyScale: number,
    dt: number,
    palmCentersOut: ScreenPt[],
  ) {
    const rig = this.rig;
    const mats = this.mats;
    if (!rig || !mats) return;

    const usedWristIdx = new Set<number>();

    for (let i = 0; i < 2; i++) {
      const hRig = rig.hands[i];
      const pLight = this.repulsorLights?.[i];
      const hand = hands[i];

      if (!hand || hand.length < 21) {
        hRig.gauntlet.visible = false;
        hRig.repulsor.visible = false;
        hRig.blastGroup.visible = false;
        hRig.fingers.forEach((f) => (f.visible = false));
        hRig.shockRings.forEach((sr) => (sr.visible = false));
        this.palmCharge[i] = Math.max(0, this.palmCharge[i] - dt * 5);
        this.palmWasOpen[i] = false;
        if (pLight) pLight.intensity = 0;
        continue;
      }

      const pts = hand.map((lm) => this.proj(lm, cover, bodyScale));
      const wrist = pts[0];
      const idxMcp = pts[5];
      const midMcp = pts[9];
      const pnkMcp = pts[17];

      // Mark closest pose wrist as already covered by full 21-point hand tracking
      trackedWrists.forEach((tw, wi) => {
        if (tw && Math.hypot(tw.x - wrist.x, tw.y - wrist.y) < bodyScale * 0.6) usedWristIdx.add(wi);
      });

      const palmW = Math.max(Math.hypot(idxMcp.x - pnkMcp.x, idxMcp.y - pnkMcp.y), bodyScale * 0.24);
      const palmCx = (wrist.x + idxMcp.x + midMcp.x + pnkMcp.x) * 0.25;
      const palmCy = (wrist.y + idxMcp.y + midMcp.y + pnkMcp.y) * 0.25;
      const palmCz = wrist.z + 44;
      palmCentersOut.push({ x: palmCx, y: palmCy, z: palmCz, vis: 1 });

      // Gauntlet hand shell
      this.placeLimb(hRig.gauntlet, wrist, midMcp, palmW * 1.24, 42, 0.65, 1.22);

      // 15 articulated armored finger phalanges per hand!
      const fingerW = palmW * 0.295;
      let fi = 0;
      for (let f = 0; f < FINGER_CHAINS.length; f++) {
        const chain = FINGER_CHAINS[f];
        for (let s = 0; s < chain.length; s++) {
          const [aIdx, bIdx] = chain[s];
          const wScale = f === 0 ? 1.12 : 1.0 - s * 0.08;
          this.placeLimb(hRig.fingers[fi++], pts[aIdx], pts[bIdx], fingerW * wScale, 46 + s, 0.72, 1.18);
        }
      }

      // Check local nanotech coverage at the palm so repulsors only fire once gauntlets have materialized!
      const origin = mats.uniforms.uNanoOrigin.value;
      const handDist = Math.hypot(palmCx - origin.x, palmCy - origin.y) / Math.max(bodyScale, 24);
      const gauntletFormed = this.suitProgress > handDist + 0.12;

      const isOpen = Boolean(openHands[i]) && gauntletFormed;
      if (isOpen && !this.palmWasOpen[i]) {
        soundFx.playRepulsorBlast();
      }
      this.palmWasOpen[i] = isOpen;

      this.palmCharge[i] = isOpen
        ? Math.min(1, this.palmCharge[i] + dt * 6.5)
        : Math.max(0, this.palmCharge[i] - dt * 5.0);
      const ch = this.palmCharge[i];

      if (gauntletFormed && (isOpen || ch > 0.04)) {
        const repR = palmW * (0.36 + ch * 0.16);
        hRig.repulsor.visible = true;
        hRig.repulsor.position.set(palmCx, palmCy, palmCz + 8);
        hRig.repulsor.scale.setScalar(repR);
        hRig.repulsorRing.rotation.z = -this.elapsed * (2.5 + ch * 5.5);
        hRig.repulsorCoronaMat.opacity = 0.55 + ch * 0.42;

        const flicker = 0.93 + 0.07 * Math.sin(this.elapsed * 32 + i * 2.1);
        hRig.blastGroup.visible = true;
        hRig.blastGroup.position.set(palmCx, palmCy, palmCz + 16);
        hRig.blastGroup.scale.setScalar(palmW * (0.42 + ch * 0.68) * flicker);
        hRig.blastGlowMat.opacity = ch * 0.85;
        hRig.blastCoreMat.opacity = ch * 0.98;

        for (let r = 0; r < hRig.shockRings.length; r++) {
          const ph = (this.elapsed * 2.1 + r * 0.5 + i * 0.25) % 1;
          const sr = hRig.shockRings[r];
          sr.visible = true;
          sr.position.set(palmCx, palmCy, palmCz + 18 + r);
          sr.scale.setScalar(palmW * (0.34 + ph * 1.45));
          hRig.shockMats[r].opacity = (1 - ph) * (1 - ph) * ch * 0.62;
        }

        if (pLight) {
          pLight.position.set(palmCx, palmCy, palmCz + bodyScale * 0.45);
          pLight.distance = bodyScale * 3.2;
          pLight.intensity = ch * 3.4 * flicker;
        }
      } else {
        hRig.repulsor.visible = false;
        hRig.blastGroup.visible = false;
        hRig.shockRings.forEach((sr) => (sr.visible = false));
        if (pLight) pLight.intensity = 0;
      }
    }

    // Pose-hand fallback gauntlets: even when hands are down by your hips in a full-body shot and HandLandmarker
    // hasn't picked up individual fingers yet, your hands STILL wear complete 3D crimson-and-gold Mark 85 gauntlets!
    const poseHands: [number, number][] = [
      [15, 19], // left wrist -> left index
      [16, 20], // right wrist -> right index
    ];
    let freeSlot = hands.length;
    for (let pi = 0; pi < poseHands.length && freeSlot < 2; pi++) {
      if (usedWristIdx.has(pi)) continue;
      const [wIdx, idxIdx] = poseHands[pi];
      const wLm = pose[wIdx];
      const iLm = pose[idxIdx];
      if (wLm && iLm && (wLm.visibility ?? 0) > 0.3 && (iLm.visibility ?? 0) > 0.28) {
        const pw = this.proj(wLm, cover, bodyScale);
        const piPt = this.proj(iLm, cover, bodyScale);
        const hRig = rig.hands[freeSlot++];
        this.placeLimb(hRig.gauntlet, pw, piPt, bodyScale * 0.38, 36, 0.7, 1.45);
      }
    }
  }

  private renderFrame() {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    const post = this.post;
    if (!renderer || !scene || !camera || !post) return;

    renderer.setRenderTarget(post.sceneRT);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    post.quad.material = post.brightMat;
    post.brightMat.uniforms.tInput.value = post.sceneRT.texture;
    renderer.setRenderTarget(post.brightRT);
    renderer.render(post.postScene, post.postCam);

    const bw = post.blurART.width;
    const bh = post.blurART.height;
    post.quad.material = post.blurMat;

    post.blurMat.uniforms.tInput.value = post.brightRT.texture;
    post.blurMat.uniforms.uStep.value.set(1 / bw, 0);
    renderer.setRenderTarget(post.blurART);
    renderer.render(post.postScene, post.postCam);

    post.blurMat.uniforms.tInput.value = post.blurART.texture;
    post.blurMat.uniforms.uStep.value.set(0, 1 / bh);
    renderer.setRenderTarget(post.blurBRT);
    renderer.render(post.postScene, post.postCam);

    post.blurMat.uniforms.tInput.value = post.blurBRT.texture;
    post.blurMat.uniforms.uStep.value.set(1.8 / bw, 0);
    renderer.setRenderTarget(post.blurART);
    renderer.render(post.postScene, post.postCam);

    post.blurMat.uniforms.tInput.value = post.blurART.texture;
    post.blurMat.uniforms.uStep.value.set(0, 1.8 / bh);
    renderer.setRenderTarget(post.blurBRT);
    renderer.render(post.postScene, post.postCam);

    post.quad.material = post.compositeMat;
    renderer.setRenderTarget(null);
    renderer.clear(true, false, false);
    renderer.render(post.postScene, post.postCam);
  }

  private emitTelemetry(force: boolean) {
    if (!this.onTelemetry) return;
    const now = performance.now();
    if (!force && now - this.lastTelemPush < 160) return;
    this.lastTelemPush = now;
    const bodyDetected = now - this.lastBodySeenAt <= BODY_GRACE_MS && this.cachedPose.length >= 25;
    this.onTelemetry({
      phase: this.suitPhase,
      visorOpen: this.visorOpen,
      bodyDetected,
      repulsorActive: this.palmCharge[0] > 0.25 || this.palmCharge[1] > 0.25,
    });
  }

  dispose() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.rig) {
      this.rig.root.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.geometry !== this.rig?.fingerGeo) {
          obj.geometry.dispose();
        }
      });
      this.rig.fingerGeo.dispose();
      this.rig.reactor.glowTexture.dispose();
      this.rig.reactor.coronaMat.dispose();
      this.rig.reactor.shockwaveMat.dispose();
      this.rig.reactor.touchRingMat.dispose();
      this.rig.hands.forEach((h) => {
        h.repulsorCoronaMat.dispose();
        h.blastCoreMat.dispose();
        h.blastGlowMat.dispose();
        h.shockMats.forEach((m) => m.dispose());
      });
      this.rig = null;
    }
    this.mats?.dispose();
    this.mats = null;
    this.post?.dispose();
    this.post = null;
    this.envTex?.dispose();
    this.envTex = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
