import * as THREE from 'three';

/**
 * Generates a high-contrast physical automotive/VFX studio HDR-like environment map via PMREM.
 * Combines bright curved softbox overhead strips, warm side fill, cool sky rim, and deep
 * negative-fill dark zones — giving authentic ILM-style metallic crimson clearcoat & brushed gold reflections.
 */
export function createStudioArmorEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x0b0e14);

  const addLightPanel = (
    w: number,
    h: number,
    colorHex: number,
    intensity: number,
    pos: [number, number, number],
    lookAt: [number, number, number] = [0, 0, 0],
  ) => {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex).multiplyScalar(intensity),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    envScene.add(mesh);
  };

  // Primary overhead studio softbox strip (creates crisp white highlight along helmet brow, pecs & shoulders)
  addLightPanel(18, 4.5, 0xfff8ee, 3.2, [0, 11, 7]);
  // Key front-left warm studio reflector (makes brushed gold & candy-red glow richly)
  addLightPanel(9, 14, 0xffe8c8, 2.4, [-11, 4, 9]);
  // Secondary front-right cool daylight strip (sculpts 3D cylindrical curve of biceps, forearms & thighs)
  addLightPanel(8, 15, 0xd8eeff, 2.1, [12, 3, 8]);
  // Upper-back dramatic rim softbox (carves silhouette edges out from background)
  addLightPanel(20, 5, 0xeef5ff, 2.6, [0, 12, -8]);
  // Subtle warm mid-horizon bounce strip (realistic room horizon reflection in chrome & gold)
  addLightPanel(24, 2.4, 0xd8c6b0, 1.15, [0, -1.5, 13]);
  // Subtle lower floor bounce (prevents bottom edges from going pitch black while preserving deep metallic contrast)
  addLightPanel(20, 12, 0x262e3a, 0.75, [0, -11, 4]);
  // Side accent specular ribbons (creates multi-band chrome reflections on liquid-metal nanotech!)
  addLightPanel(3.2, 16, 0xffffff, 2.8, [-14, 1, 2]);
  addLightPanel(3.2, 16, 0xf2f8ff, 2.5, [14, 2, 2]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const texture = pmrem.fromScene(envScene, 0.032).texture;

  // Clean up temporary environment scene meshes
  envScene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  pmrem.dispose();
  return texture;
}

/**
 * Radial optical glow texture with crisp hot center and natural inverse-square falloff
 * for realistic Arc Reactor, eye lens, and palm repulsor light spill.
 */
export function createOpticalGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(128, 128, 2, 128, 128, 124);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.14, 'rgba(220, 250, 255, 0.85)');
    grad.addColorStop(0.36, 'rgba(110, 222, 255, 0.34)');
    grad.addColorStop(0.68, 'rgba(45, 175, 245, 0.08)');
    grad.addColorStop(1.0, 'rgba(20, 130, 220, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * Real-time webcam room light probe: samples a tiny 12x8 downscale of the live video
 * to adapt 3D armor lighting intensity, key-light direction, and ambient color temperature
 * so the Iron Man suit matches the user's real room lighting naturally.
 */
export class WebcamLightProbe {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private lastSampleAt = -1000;

  readonly tint = new THREE.Color(1, 1, 1);
  luminance = 0.62;
  dirX = -0.3;
  dirY = 0.65;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 12;
    this.canvas.height = 8;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  sample(video: HTMLVideoElement | null, time: number, delta: number) {
    if (!video || !this.ctx || video.readyState < 2 || video.videoWidth < 2) return;
    if (time - this.lastSampleAt < 180) return;
    this.lastSampleAt = time;

    try {
      this.ctx.drawImage(video, 0, 0, 12, 8);
      const data = this.ctx.getImageData(0, 0, 12, 8).data;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let leftLum = 0;
      let rightLum = 0;
      let topLum = 0;
      let botLum = 0;
      const count = 12 * 8;

      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 12; x++) {
          const i = (y * 12 + x) * 4;
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          rSum += r;
          gSum += g;
          bSum += b;
          if (x < 6) leftLum += lum;
          else rightLum += lum;
          if (y < 4) topLum += lum;
          else botLum += lum;
        }
      }

      const avgR = rSum / count;
      const avgG = gSum / count;
      const avgB = bSum / count;
      const avgLum = Math.max(0.299 * avgR + 0.587 * avgG + 0.114 * avgB, 0.05);

      // Normalize color cast softly so armor takes on room warmth/coolness without shifting red/gold hue too far
      const maxCh = Math.max(avgR, avgG, avgB, 0.08);
      const targetTint = new THREE.Color(
        THREE.MathUtils.lerp(1.0, avgR / maxCh, 0.34),
        THREE.MathUtils.lerp(1.0, avgG / maxCh, 0.34),
        THREE.MathUtils.lerp(1.0, avgB / maxCh, 0.34),
      );

      const smooth = 1 - Math.exp(-Math.max(delta, 0.16) / 0.45);
      this.tint.lerp(targetTint, smooth);
      this.luminance = THREE.MathUtils.lerp(
        this.luminance,
        THREE.MathUtils.clamp(avgLum, 0.22, 0.95),
        smooth,
      );

      const targetDirX = THREE.MathUtils.clamp(((rightLum - leftLum) / (count * 0.5)) * 2.4, -0.85, 0.85);
      const targetDirY = THREE.MathUtils.clamp(0.45 + ((topLum - botLum) / (count * 0.5)) * 1.6, 0.2, 0.95);
      this.dirX = THREE.MathUtils.lerp(this.dirX, targetDirX, smooth);
      this.dirY = THREE.MathUtils.lerp(this.dirY, targetDirY, smooth);
    } catch {
      // Ignore transient frame read issues
    }
  }
}
