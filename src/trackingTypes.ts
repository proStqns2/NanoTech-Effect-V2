export type Landmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type TrackingFrame = {
  pose: Landmark[];
  face: Landmark[];
  hands: Landmark[][];
  openHands: boolean[];
  fps: number;
};

export type CameraStatus = 'idle' | 'loading' | 'ready' | 'error';

export type TrackingWorkerRequest =
  | { type: 'initialize' }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number };

export type TrackingWorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'frame'; timestamp: number; pose: Landmark[]; face: Landmark[]; hands: Landmark[][]; openHands: boolean[] }
  | { type: 'error'; message: string };
