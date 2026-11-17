import { useCallback, useEffect, useRef, useState } from 'react';
import type { BodyVisionEngine } from './trackingEngine';
import type { CameraErrorKind, CameraStatus, TrackingFrame, TrackingWorkerResponse } from './trackingTypes';

const TRACKING_INPUT_MAX_SIZE = 480;
const TRACKING_MAX_FPS_GPU = 26;
const TRACKING_MAX_FPS_CPU = 14;

const EMPTY_FRAME: TrackingFrame = {
  pose: [],
  worldPose: [],
  face: [],
  faceMatrix: null,
  hands: [],
  openHands: [],
  fps: 0,
};

export type VideoDeviceOption = {
  deviceId: string;
  label: string;
};

function isRunningInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function classifyCameraError(reason: unknown): { kind: CameraErrorKind; message: string } {
  const inIframe = isRunningInIframe();

  if (reason instanceof DOMException) {
    if (
      reason.name === 'NotAllowedError' ||
      reason.name === 'PermissionDeniedError' ||
      reason.name === 'SecurityError'
    ) {
      if (inIframe) {
        return {
          kind: 'iframe-blocked',
          message:
            'L’aperçu intégré du navigateur bloque l’accès direct à la webcam. Ouvrez la page en plein onglet pour activer automatiquement votre caméra.',
        };
      }
      return {
        kind: 'permission-denied',
        message:
          'L’accès à la webcam est bloqué dans votre navigateur. Cliquez sur l’icône caméra ou cadenas à gauche de la barre d’adresse, choisissez « Autoriser », puis cliquez sur Réessayer.',
      };
    }

    if (reason.name === 'NotFoundError' || reason.name === 'DevicesNotFoundError') {
      return {
        kind: 'not-found',
        message: 'Aucune webcam n’a été détectée sur votre PC. Vérifiez qu’elle est bien branchée et activée.',
      };
    }

    if (reason.name === 'NotReadableError' || reason.name === 'TrackStartError') {
      return {
        kind: 'in-use',
        message:
          'Votre webcam est déjà utilisée par une autre application (Discord, Zoom, OBS, Caméra Windows). Fermez-la puis réessayez.',
      };
    }
  }

  if (inIframe) {
    return {
      kind: 'iframe-blocked',
      message: 'Ouvrez la page dans un nouvel onglet pour autoriser l’accès direct à votre webcam PC.',
    };
  }

  return {
    kind: 'generic',
    message: reason instanceof Error ? reason.message : 'Impossible d’ouvrir la webcam.',
  };
}

/** Tries progressively relaxed getUserMedia constraints so every PC/laptop webcam opens cleanly. */
async function requestWebcamStream(preferredDeviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('La webcam nécessite HTTPS ou localhost (http://localhost:5173).');
  }

  const attempts: MediaStreamConstraints[] = preferredDeviceId
    ? [
        {
          audio: false,
          video: { deviceId: { exact: preferredDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        },
        { audio: false, video: { deviceId: { exact: preferredDeviceId } } },
        { audio: false, video: true },
      ]
    : [
        {
          audio: false,
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        },
        { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
        { audio: false, video: true },
      ];

  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
      // If permission was explicitly denied or no camera exists, don't trigger duplicate prompts
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' ||
          err.name === 'PermissionDeniedError' ||
          err.name === 'SecurityError' ||
          err.name === 'NotFoundError' ||
          err.name === 'DevicesNotFoundError' ||
          err.name === 'NotReadableError')
      ) {
        throw err;
      }
    }
  }
  throw lastError;
}

export function useArmorTracking() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const fallbackEngineRef = useRef<BodyVisionEngine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const busyRef = useRef(false);
  const cpuRef = useRef(false);
  const lastVideoTimeRef = useRef(-1);
  const lastSubmitRef = useRef(0);
  const fpsRef = useRef({ count: 0, start: 0, value: 0 });
  const latestFrameRef = useRef<TrackingFrame>(EMPTY_FRAME);

  const [status, setStatus] = useState<CameraStatus>('starting');
  const [trackerReady, setTrackerReady] = useState(false);
  const [trackerError, setTrackerError] = useState('');
  const [errorKind, setErrorKind] = useState<CameraErrorKind>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [cameras, setCameras] = useState<VideoDeviceOption[]>([]);
  const [activeCameraId, setActiveCameraId] = useState('');

  const cleanup = useCallback(() => {
    sessionRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    workerRef.current?.terminate();
    workerRef.current = null;
    fallbackEngineRef.current?.close();
    fallbackEngineRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    busyRef.current = false;
    lastVideoTimeRef.current = -1;
    lastSubmitRef.current = 0;
    fpsRef.current = { count: 0, start: 0, value: 0 };
    latestFrameRef.current = EMPTY_FRAME;
    setTrackerReady(false);
  }, []);

  const updateCameraDevices = useCallback(async (stream: MediaStream) => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      const vids = list
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Caméra ${i + 1}` }));
      setCameras(vids);
      const id = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (id) setActiveCameraId(id);
    } catch {
      // Ignore enumerate failures
    }
  }, []);

  const recordDetection = useCallback(
    (payload: Omit<TrackingFrame, 'fps'>) => {
      const now = performance.now();
      if (fpsRef.current.start === 0) fpsRef.current.start = now;
      fpsRef.current.count += 1;
      const dt = now - fpsRef.current.start;
      if (dt >= 900) {
        fpsRef.current.value = Math.round((fpsRef.current.count * 1000) / dt);
        fpsRef.current.count = 0;
        fpsRef.current.start = now;
      }
      latestFrameRef.current = { ...payload, fps: fpsRef.current.value };
    },
    [],
  );

  const startCamera = useCallback(
    async (preferredDeviceId?: string) => {
      cleanup();
      const mySession = sessionRef.current;

      setStatus('starting');
      setErrorKind(null);
      setErrorMessage('');
      setTrackerError('');

      try {
        // 1. Open and display the live webcam IMMEDIATELY (full screen!)
        const stream = await requestWebcamStream(preferredDeviceId);
        if (sessionRef.current !== mySession) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        void updateCameraDevices(stream);

        const video = videoRef.current;
        if (!video) throw new Error('Élément vidéo introuvable.');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        if (video.readyState < 1) {
          await new Promise<void>((resolve) => {
            const done = () => {
              video.removeEventListener('loadedmetadata', done);
              resolve();
            };
            video.addEventListener('loadedmetadata', done, { once: true });
            window.setTimeout(done, 1200);
          });
        }
        await video.play().catch(() => {});
        if (sessionRef.current !== mySession) return;

        // Webcam is now visibly LIVE on screen!
        setStatus('ready');

        // 2. Boot MediaPipe full-body + face + hands engine in Worker, with automatic main-thread fallback!
        let useFallbackMainThread = false;
        let workerReady = false;

        try {
          const worker = new Worker(new URL('./armorTracking.worker.ts', import.meta.url), { type: 'module' });
          workerRef.current = worker;

          await new Promise<void>((resolve, reject) => {
            worker.onmessage = ({ data }: MessageEvent<TrackingWorkerResponse>) => {
              if (sessionRef.current !== mySession) return;
              if (data.type === 'ready') {
                cpuRef.current = data.delegate === 'CPU';
                workerReady = true;
                resolve();
                return;
              }
              if (data.type === 'error') {
                reject(new Error(data.message));
                return;
              }
              busyRef.current = false;
              recordDetection({
                pose: data.pose,
                worldPose: data.worldPose,
                face: data.face,
                faceMatrix: data.faceMatrix,
                hands: data.hands,
                openHands: data.openHands,
              });
            };
            worker.onerror = (ev) => reject(new Error(ev.message || 'Worker error'));
            worker.postMessage({ type: 'initialize' });
          });
        } catch {
          // Worker unavailable or blocked — seamlessly run MediaPipe on main thread!
          workerRef.current?.terminate();
          workerRef.current = null;
          useFallbackMainThread = true;
          const { BodyVisionEngine } = await import('./trackingEngine');
          if (sessionRef.current !== mySession) return;
          const engine = new BodyVisionEngine();
          const delegate = await engine.initialize();
          if (sessionRef.current !== mySession) {
            engine.close();
            return;
          }
          fallbackEngineRef.current = engine;
          cpuRef.current = delegate === 'CPU';
        }

        if (sessionRef.current !== mySession) return;
        setTrackerReady(true);

        // 3. Continuous low-latency full-body tracking loop
        const loop = () => {
          if (sessionRef.current !== mySession) return;
          const v = videoRef.current;
          const now = performance.now();
          const maxFps = cpuRef.current ? TRACKING_MAX_FPS_CPU : TRACKING_MAX_FPS_GPU;

          if (
            v &&
            !busyRef.current &&
            v.readyState >= 2 &&
            v.videoWidth > 0 &&
            v.videoHeight > 0 &&
            v.currentTime !== lastVideoTimeRef.current &&
            now - lastSubmitRef.current >= 1000 / maxFps
          ) {
            lastVideoTimeRef.current = v.currentTime;
            lastSubmitRef.current = now;

            if (useFallbackMainThread && fallbackEngineRef.current) {
              try {
                const res = fallbackEngineRef.current.detect(v, now);
                recordDetection({
                  pose: res.pose,
                  worldPose: res.worldPose,
                  face: res.face,
                  faceMatrix: res.faceMatrix,
                  hands: res.hands,
                  openHands: res.openHands,
                });
              } catch {
                // Skip transient frame glitch
              }
            } else if (workerReady && workerRef.current && typeof createImageBitmap === 'function') {
              const activeWorker = workerRef.current;
              busyRef.current = true;
              const scale = Math.min(1, TRACKING_INPUT_MAX_SIZE / Math.max(v.videoWidth, v.videoHeight));
              const resizeWidth = Math.max(1, Math.round(v.videoWidth * scale));
              const resizeHeight = Math.max(1, Math.round(v.videoHeight * scale));

              void createImageBitmap(v, { resizeWidth, resizeHeight, resizeQuality: 'low' })
                .then((bitmap) => {
                  if (sessionRef.current !== mySession || workerRef.current !== activeWorker) {
                    bitmap.close();
                    busyRef.current = false;
                    return;
                  }
                  activeWorker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]);
                })
                .catch(() => {
                  busyRef.current = false;
                });
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };

        rafRef.current = requestAnimationFrame(loop);
      } catch (reason) {
        if (sessionRef.current !== mySession) return;
        // If video already started and only MediaPipe failed, keep webcam open and show subtle error
        if (streamRef.current) {
          setTrackerError(
            reason instanceof Error
              ? `Suivi IA indisponible : ${reason.message}`
              : 'Impossible de charger les modèles de détection du corps.',
          );
          return;
        }
        cleanup();
        const classified = classifyCameraError(reason);
        setErrorKind(classified.kind);
        setErrorMessage(classified.message);
        setStatus('error');
      }
    },
    [cleanup, recordDetection, updateCameraDevices],
  );

  // Auto-start the webcam IMMEDIATELY as soon as the user flips Camera permission to "Allow"!
  useEffect(() => {
    if (status !== 'error' || errorKind !== 'permission-denied') return;
    let permStatus: PermissionStatus | null = null;
    let cancelled = false;

    const onPermChange = () => {
      if (!cancelled && permStatus?.state === 'granted') {
        void startCamera();
      }
    };

    if (navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: 'camera' as PermissionName })
        .then((ps) => {
          if (cancelled) return;
          permStatus = ps;
          ps.addEventListener('change', onPermChange);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      permStatus?.removeEventListener('change', onPermChange);
    };
  }, [errorKind, startCamera, status]);

  const cycleCamera = useCallback(() => {
    if (cameras.length < 2) return;
    const idx = cameras.findIndex((c) => c.deviceId === activeCameraId);
    const next = cameras[(idx + 1) % cameras.length];
    if (next) void startCamera(next.deviceId);
  }, [activeCameraId, cameras, startCamera]);

  useEffect(() => cleanup, [cleanup]);

  return {
    videoRef,
    latestFrameRef,
    status,
    trackerReady,
    trackerError,
    errorKind,
    errorMessage,
    cameras,
    startCamera,
    cycleCamera,
  };
}
