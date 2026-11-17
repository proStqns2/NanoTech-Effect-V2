import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './trackingTypes';

const MODEL_URLS = {
  poseFull:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  poseLite:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

const FACE_INTERVAL_GPU_MS = 52;
const FACE_INTERVAL_CPU_MS = 115;
const HAND_INTERVAL_GPU_MS = 54;
const HAND_INTERVAL_CPU_MS = 105;

function dist2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Detects open-palm Iron Man repulsor firing gesture. */
export function detectOpenPalm(hand: Landmark[]): boolean {
  if (hand.length < 21) return false;
  const wrist = hand[0];
  const palmWidth = dist2D(hand[5], hand[17]);
  if (palmWidth < 0.01) return false;

  const extended = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ].filter(([tip, pip]) => dist2D(wrist, hand[tip]) > dist2D(wrist, hand[pip]) * 1.08);

  const thumbOpen = dist2D(hand[4], hand[17]) > palmWidth * 1.14;
  const spread = (dist2D(hand[8], hand[20]) + dist2D(hand[12], hand[16])) / (2 * palmWidth);
  const facing =
    Math.abs((hand[5].x - wrist.x) * (hand[17].y - wrist.y) - (hand[5].y - wrist.y) * (hand[17].x - wrist.x)) >
    palmWidth * palmWidth * 0.15;

  return extended.length >= 3 && thumbOpen && spread > 0.88 && facing;
}

export type VisionTrackerResult = {
  timestamp: number;
  pose: Landmark[];
  worldPose: Landmark[];
  face: Landmark[];
  faceMatrix: number[] | null;
  hands: Landmark[][];
  openHands: boolean[];
};

export class BodyVisionEngine {
  delegate: 'GPU' | 'CPU' = 'GPU';

  private pose: PoseLandmarker | null = null;
  private face: FaceLandmarker | null = null;
  private hands: HandLandmarker | null = null;
  private baseFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private instanceSeq = 0;
  private lastTs = 0;
  private lastFaceTs = -1000;
  private lastHandTs = -1000;
  private cachedFace: Landmark[] = [];
  private cachedFaceMatrix: number[] | null = null;
  private cachedHands: Landmark[][] = [];
  private cachedOpenHands: boolean[] = [];

  private async nextFileset() {
    if (!this.baseFileset) {
      this.baseFileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    }
    const url = new URL(this.baseFileset.wasmLoaderPath);
    url.searchParams.set('inst', String(this.instanceSeq++));
    return { ...this.baseFileset, wasmLoaderPath: url.toString() };
  }

  private async buildWithDelegate(requested: 'GPU' | 'CPU') {
    let pose: PoseLandmarker | undefined;
    let face: FaceLandmarker | undefined;
    let hands: HandLandmarker | undefined;

    try {
      // Prefer high-accuracy Full body pose model on GPU; fall back to Lite on CPU for speed
      const poseUrl = requested === 'GPU' ? MODEL_URLS.poseFull : MODEL_URLS.poseLite;
      try {
        pose = await PoseLandmarker.createFromOptions(await this.nextFileset(), {
          baseOptions: { modelAssetPath: poseUrl, delegate: requested },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.45,
        });
      } catch {
        pose = await PoseLandmarker.createFromOptions(await this.nextFileset(), {
          baseOptions: { modelAssetPath: MODEL_URLS.poseLite, delegate: requested },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.42,
        });
      }

      face = await FaceLandmarker.createFromOptions(await this.nextFileset(), {
        baseOptions: { modelAssetPath: MODEL_URLS.face, delegate: requested },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.42,
      });

      hands = await HandLandmarker.createFromOptions(await this.nextFileset(), {
        baseOptions: { modelAssetPath: MODEL_URLS.hand, delegate: requested },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.42,
        minTrackingConfidence: 0.42,
      });

      this.pose = pose;
      this.face = face;
      this.hands = hands;
      this.delegate = requested;
    } catch (err) {
      pose?.close();
      face?.close();
      hands?.close();
      throw err;
    }
  }

  async initialize(): Promise<'GPU' | 'CPU'> {
    try {
      await this.buildWithDelegate('GPU');
    } catch {
      await this.buildWithDelegate('CPU');
    }
    this.lastTs = 0;
    this.lastFaceTs = -1000;
    this.lastHandTs = -1000;
    return this.delegate;
  }

  detect(source: ImageBitmap | HTMLVideoElement, rawTimestamp: number): VisionTrackerResult {
    const timestamp = Math.max(this.lastTs + 1, Math.round(rawTimestamp));
    this.lastTs = timestamp;

    if (!this.pose || !this.face || !this.hands) {
      return {
        timestamp,
        pose: [],
        worldPose: [],
        face: [],
        faceMatrix: null,
        hands: [],
        openHands: [],
      };
    }

    const faceStep = this.delegate === 'GPU' ? FACE_INTERVAL_GPU_MS : FACE_INTERVAL_CPU_MS;
    const handStep = this.delegate === 'GPU' ? HAND_INTERVAL_GPU_MS : HAND_INTERVAL_CPU_MS;

    const poseResult = this.pose.detectForVideo(source, timestamp);
    const pose = poseResult.landmarks[0] ?? [];
    const worldPose = poseResult.worldLandmarks[0] ?? [];

    if (timestamp - this.lastFaceTs >= faceStep) {
      const faceRes = this.face.detectForVideo(source, timestamp);
      this.cachedFace = faceRes.faceLandmarks[0] ?? [];
      const matData = faceRes.facialTransformationMatrixes?.[0]?.data;
      this.cachedFaceMatrix = matData ? Array.from(matData) : null;
      this.lastFaceTs = timestamp;
    }

    if (timestamp - this.lastHandTs >= handStep) {
      const handRes = this.hands.detectForVideo(source, timestamp);
      this.cachedHands = handRes.landmarks ?? [];
      this.cachedOpenHands = this.cachedHands.map(detectOpenPalm);
      this.lastHandTs = timestamp;
    }

    return {
      timestamp,
      pose,
      worldPose,
      face: this.cachedFace,
      faceMatrix: this.cachedFaceMatrix,
      hands: this.cachedHands,
      openHands: this.cachedOpenHands,
    };
  }

  close() {
    this.pose?.close();
    this.face?.close();
    this.hands?.close();
    this.pose = null;
    this.face = null;
    this.hands = null;
  }
}
