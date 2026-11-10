import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, TrackingWorkerRequest, TrackingWorkerResponse } from './trackingTypes';

declare const self: {
  onmessage: ((event: MessageEvent<TrackingWorkerRequest>) => void) | null;
  postMessage(message: TrackingWorkerResponse): void;
};

const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

const FACE_UPDATE_INTERVAL_MS = 220;
const HAND_UPDATE_INTERVAL_MS = 100;
const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

let detectors: {
  face: FaceLandmarker;
  pose: PoseLandmarker;
  hands: HandLandmarker;
} | null = null;
let delegate: 'GPU' | 'CPU' = 'GPU';
let lastFaceDetection = 0;
let lastHandDetection = 0;
let faceLandmarks: Landmark[] = [];
let handLandmarks: Landmark[][] = [];
let openHands: boolean[] = [];
let wasmModuleInstance = 0;

function distanceBetween(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isOpenHand(hand: Landmark[]) {
  if (hand.length < 21) return false;
  const wrist = hand[0];
  const palmWidth = distanceBetween(hand[5], hand[17]);
  if (palmWidth < 0.001) return false;

  const extendedFingers = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ].filter(([tip, joint]) => distanceBetween(wrist, hand[tip]) > distanceBetween(wrist, hand[joint]) * 1.08);
  const thumbIsOpen = distanceBetween(hand[4], hand[0]) > distanceBetween(hand[3], hand[0]) * 1.04;
  const fingerSpread =
    (distanceBetween(hand[8], hand[20]) + distanceBetween(hand[12], hand[16])) / (2 * palmWidth);
  const palmFacingCamera =
    Math.abs(
      (hand[5].x - wrist.x) * (hand[17].y - wrist.y) -
        (hand[5].y - wrist.y) * (hand[17].x - wrist.x),
    ) >
    palmWidth * palmWidth * 0.16;

  return extendedFingers.length >= 3 && thumbIsOpen && fingerSpread > 0.9 && palmFacingCamera;
}

async function createDetectorFileset() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL, true);
  const loaderUrl = new URL(fileset.wasmLoaderPath);
  loaderUrl.searchParams.set('worker-instance', String(wasmModuleInstance++));
  return { ...fileset, wasmLoaderPath: loaderUrl.toString() };
}

async function createDetectors(requestedDelegate: 'GPU' | 'CPU') {
  let face: FaceLandmarker | undefined;
  let pose: PoseLandmarker | undefined;
  let hands: HandLandmarker | undefined;

  try {
    face = await FaceLandmarker.createFromOptions(await createDetectorFileset(), {
      baseOptions: { modelAssetPath: MODEL_URLS.face, delegate: requestedDelegate },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    pose = await PoseLandmarker.createFromOptions(await createDetectorFileset(), {
      baseOptions: { modelAssetPath: MODEL_URLS.pose, delegate: requestedDelegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    hands = await HandLandmarker.createFromOptions(await createDetectorFileset(), {
      baseOptions: { modelAssetPath: MODEL_URLS.hand, delegate: requestedDelegate },
      runningMode: 'VIDEO',
      numHands: 2,
    });
    return { face, pose, hands };
  } catch (reason) {
    face?.close();
    pose?.close();
    hands?.close();
    throw reason;
  }
}

async function initialize() {
  try {
    detectors = await createDetectors('GPU');
  } catch {
    delegate = 'CPU';
    try {
      detectors = await createDetectors('CPU');
    } catch (reason) {
      throw new Error(
        `MediaPipe n’a pas pu démarrer sur le GPU ni sur le CPU : ${
          reason instanceof Error ? reason.message : 'erreur inconnue'
        }`,
      );
    }
  }

  self.postMessage({ type: 'ready', delegate });
}

function processFrame(bitmap: ImageBitmap, timestamp: number) {
  if (!detectors) throw new Error('Le moteur de suivi n’est pas initialisé.');

  try {
    const pose = detectors.pose.detectForVideo(bitmap, timestamp).landmarks[0] ?? [];
    if (timestamp - lastFaceDetection >= FACE_UPDATE_INTERVAL_MS) {
      faceLandmarks = detectors.face.detectForVideo(bitmap, timestamp).faceLandmarks[0] ?? [];
      lastFaceDetection = timestamp;
    }
    if (timestamp - lastHandDetection >= HAND_UPDATE_INTERVAL_MS) {
      handLandmarks = detectors.hands.detectForVideo(bitmap, timestamp).landmarks ?? [];
      openHands = handLandmarks.map(isOpenHand);
      lastHandDetection = timestamp;
    }

    self.postMessage({
      type: 'frame',
      timestamp,
      pose,
      face: faceLandmarks,
      hands: handLandmarks,
      openHands,
    });
  } finally {
    bitmap.close();
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'initialize') {
    void initialize().catch((reason: unknown) => {
      self.postMessage({
        type: 'error',
        message: reason instanceof Error ? reason.message : 'Le moteur MediaPipe n’a pas pu démarrer.',
      });
    });
    return;
  }

  try {
    processFrame(data.bitmap, data.timestamp);
  } catch (reason) {
    self.postMessage({
      type: 'error',
      message: reason instanceof Error ? reason.message : 'Le suivi MediaPipe a été interrompu.',
    });
  }
};
