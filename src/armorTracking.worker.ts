import { BodyVisionEngine } from './trackingEngine';
import type { TrackingWorkerRequest, TrackingWorkerResponse } from './trackingTypes';

declare const self: {
  onmessage: ((event: MessageEvent<TrackingWorkerRequest>) => void) | null;
  postMessage(message: TrackingWorkerResponse): void;
};

const engine = new BodyVisionEngine();

self.onmessage = ({ data }) => {
  if (data.type === 'initialize') {
    void engine
      .initialize()
      .then((delegate) => {
        self.postMessage({ type: 'ready', delegate });
      })
      .catch((reason: unknown) => {
        self.postMessage({
          type: 'error',
          message: reason instanceof Error ? reason.message : 'Échec d’initialisation MediaPipe.',
        });
      });
    return;
  }

  try {
    const res = engine.detect(data.bitmap, data.timestamp);
    self.postMessage({ type: 'frame', ...res });
  } catch {
    self.postMessage({
      type: 'frame',
      timestamp: Math.round(data.timestamp),
      pose: [],
      worldPose: [],
      face: [],
      faceMatrix: null,
      hands: [],
      openHands: [],
    });
  } finally {
    data.bitmap.close();
  }
};
