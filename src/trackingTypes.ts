export type Landmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type TrackingFrame = {
  pose: Landmark[];
  worldPose: Landmark[];
  face: Landmark[];
  /** Optional 4x4 column-major facial transformation matrix from MediaPipe */
  faceMatrix: number[] | null;
  hands: Landmark[][];
  openHands: boolean[];
  fps: number;
};

export type CameraErrorKind = 'iframe-blocked' | 'permission-denied' | 'not-found' | 'in-use' | 'generic' | null;

export type CameraStatus = 'starting' | 'ready' | 'error';

export type SuitPhase = 'searching' | 'equipping' | 'equipped' | 'retracting' | 'retracted';

export type SuitTelemetry = {
  phase: SuitPhase;
  visorOpen: boolean;
  bodyDetected: boolean;
  repulsorActive: boolean;
};

export type TrackingWorkerRequest =
  | { type: 'initialize' }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number };

export type TrackingWorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | {
      type: 'frame';
      timestamp: number;
      pose: Landmark[];
      worldPose: Landmark[];
      face: Landmark[];
      faceMatrix: number[] | null;
      hands: Landmark[][];
      openHands: boolean[];
    }
  | { type: 'error'; message: string };
