import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraStatus, Landmark, TrackingFrame, TrackingWorkerResponse } from './trackingTypes';

export type { CameraStatus, Landmark, TrackingFrame } from './trackingTypes';

// Keep pose inference responsive enough for smooth suit placement while bounding
// the amount of work sent to slower CPUs. Three.js interpolates between results.
const TRACKING_INPUT_MAX_SIZE = 512;
const GPU_TRACKING_MAX_FPS = 18;
const CPU_TRACKING_MAX_FPS = 12;

const EMPTY_FRAME: TrackingFrame = {
  pose: [],
  face: [],
  hands: [],
  openHands: [],
  fps: 0,
};

export function useArmorTracking() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerBusyRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const lastFrameSubmittedAtRef = useRef(0);
  const trackingMaxFpsRef = useRef(GPU_TRACKING_MAX_FPS);
  const fpsRef = useRef({ frames: 0, startedAt: performance.now(), value: 0 });
  const lastPublishedFrameRef = useRef(0);
  const latestFrameRef = useRef(EMPTY_FRAME);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState('');
  const [cpuMode, setCpuMode] = useState(false);
  const [frame, setFrame] = useState<TrackingFrame>(EMPTY_FRAME);

  const stopCamera = useCallback(() => {
    if (frameRequestRef.current !== null) {
      cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    workerReadyRef.current = false;
    workerBusyRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) videoRef.current.srcObject = null;

    lastVideoTimeRef.current = -1;
    lastFrameSubmittedAtRef.current = 0;
    trackingMaxFpsRef.current = GPU_TRACKING_MAX_FPS;
    fpsRef.current = { frames: 0, startedAt: performance.now(), value: 0 };
    lastPublishedFrameRef.current = 0;
    latestFrameRef.current = EMPTY_FRAME;
    setStatus('idle');
    setCpuMode(false);
    setFrame(EMPTY_FRAME);
  }, []);

  const startCamera = useCallback(async () => {
    if (status === 'loading' || status === 'ready') return;

    setStatus('loading');
    setError('');
    lastFrameSubmittedAtRef.current = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('La caméra est indisponible. Ouvrez le site en HTTPS ou sur localhost.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error('Le lecteur vidéo n’a pas pu être initialisé.');
      video.srcObject = stream;
      await video.play();

      const worker = new Worker(new URL('./armorTracking.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      let resolveInitialization: (() => void) | null = null;
      let rejectInitialization: ((reason: Error) => void) | null = null;
      let initialized = false;
      const initialization = new Promise<void>((resolve, reject) => {
        resolveInitialization = resolve;
        rejectInitialization = reject;
      });

      const failTracking = (reason: unknown) => {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        if (frameRequestRef.current !== null) {
          cancelAnimationFrame(frameRequestRef.current);
          frameRequestRef.current = null;
        }
        workerReadyRef.current = false;
        workerBusyRef.current = false;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setError(
          reason instanceof Error
            ? `Le suivi a été interrompu : ${reason.message}`
            : 'Le suivi a été interrompu par une erreur inconnue.',
        );
        setStatus('error');
      };

      worker.onmessage = ({ data }: MessageEvent<TrackingWorkerResponse>) => {
        if (data.type === 'ready') {
          initialized = true;
          workerReadyRef.current = true;
          trackingMaxFpsRef.current = data.delegate === 'CPU' ? CPU_TRACKING_MAX_FPS : GPU_TRACKING_MAX_FPS;
          setCpuMode(data.delegate === 'CPU');
          resolveInitialization?.();
          resolveInitialization = null;
          rejectInitialization = null;
          return;
        }

        if (data.type === 'error') {
          if (!initialized) {
            rejectInitialization?.(new Error(data.message));
            resolveInitialization = null;
            rejectInitialization = null;
          } else {
            failTracking(new Error(data.message));
          }
          return;
        }

        workerBusyRef.current = false;
        fpsRef.current.frames += 1;
        const elapsed = data.timestamp - fpsRef.current.startedAt;
        if (elapsed >= 1000) {
          fpsRef.current.value = Math.round((fpsRef.current.frames * 1000) / elapsed);
          fpsRef.current.frames = 0;
          fpsRef.current.startedAt = data.timestamp;
        }

        const nextFrame: TrackingFrame = {
          pose: data.pose,
          face: data.face,
          hands: data.hands,
          openHands: data.openHands,
          fps: fpsRef.current.value,
        };
        latestFrameRef.current = nextFrame;

        // Keep React/UI updates lightweight; the WebGL loop consumes every result
        // directly through latestFrameRef and interpolates it between renders.
        if (data.timestamp - lastPublishedFrameRef.current >= 100 || lastPublishedFrameRef.current === 0) {
          lastPublishedFrameRef.current = data.timestamp;
          setFrame(nextFrame);
        }
      };
      worker.onerror = (event) => {
        const reason = new Error(event.message || 'Le worker MediaPipe a rencontré une erreur.');
        if (!initialized) {
          rejectInitialization?.(reason);
          resolveInitialization = null;
          rejectInitialization = null;
        } else {
          failTracking(reason);
        }
      };

      worker.postMessage({ type: 'initialize' });
      await initialization;
      setStatus('ready');
      fpsRef.current = { frames: 0, startedAt: performance.now(), value: 0 };
      lastPublishedFrameRef.current = 0;

      const detect = () => {
        const activeVideo = videoRef.current;
        const activeWorker = workerRef.current;
        const timestamp = performance.now();
        if (
          activeVideo &&
          activeWorker &&
          workerReadyRef.current &&
          !workerBusyRef.current &&
          activeVideo.readyState >= 2 &&
          activeVideo.currentTime !== lastVideoTimeRef.current &&
          timestamp - lastFrameSubmittedAtRef.current >= 1000 / trackingMaxFpsRef.current
        ) {
          lastVideoTimeRef.current = activeVideo.currentTime;
          lastFrameSubmittedAtRef.current = timestamp;
          workerBusyRef.current = true;
          const scale = Math.min(
            1,
            TRACKING_INPUT_MAX_SIZE / Math.max(activeVideo.videoWidth, activeVideo.videoHeight),
          );
          const resizeWidth = Math.max(1, Math.round(activeVideo.videoWidth * scale));
          const resizeHeight = Math.max(1, Math.round(activeVideo.videoHeight * scale));

          void createImageBitmap(activeVideo, { resizeWidth, resizeHeight, resizeQuality: 'medium' })
            .then((bitmap) => {
              if (workerRef.current !== activeWorker || !workerReadyRef.current) {
                bitmap.close();
                workerBusyRef.current = false;
                return;
              }
              activeWorker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
            })
            .catch((reason: unknown) => failTracking(reason));
        }

        frameRequestRef.current = requestAnimationFrame(detect);
      };

      frameRequestRef.current = requestAnimationFrame(detect);
    } catch (reason) {
      workerRef.current?.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
      workerBusyRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      const message =
        reason instanceof Error ? reason.message : 'La caméra ou les modèles de suivi n’ont pas pu démarrer.';
      setError(message);
      setStatus('error');
    }
  }, [status]);

  useEffect(() => stopCamera, [stopCamera]);

  return { videoRef, frame, latestFrameRef, status, error, cpuMode, startCamera, stopCamera };
}
