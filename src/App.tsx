import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldOff,
  SwitchCamera,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { ArmorOverlayController } from './ArmorOverlay';
import { soundFx } from './soundEffects';
import type { SuitTelemetry } from './trackingTypes';
import { useArmorTracking } from './useArmorTracking';

const INITIAL_TELEMETRY: SuitTelemetry = {
  phase: 'searching',
  visorOpen: false,
  bodyDetected: false,
  repulsorActive: false,
};

function detectEmbeddedFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export default function App() {
  const {
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
  } = useArmorTracking();

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ArmorOverlayController | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const [telemetry, setTelemetry] = useState<SuitTelemetry>(INITIAL_TELEMETRY);
  const [soundOn, setSoundOn] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsAwake, setControlsAwake] = useState(true);
  const [pageUrl, setPageUrl] = useState('');
  const [inIframe, setInIframe] = useState(false);
  const [showStartActions, setShowStartActions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [webglError, setWebglError] = useState('');

  // StrictMode-safe single auto-start of the PC webcam on load
  useEffect(() => {
    setPageUrl(window.location.href);
    setInIframe(detectEmbeddedFrame());
    const timer = window.setTimeout(() => {
      void startCamera();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [startCamera]);

  // Show manual action buttons if the browser holds the camera prompt open > 2s
  useEffect(() => {
    if (status !== 'starting') {
      setShowStartActions(false);
      return;
    }
    const timer = window.setTimeout(() => setShowStartActions(true), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Mount fullscreen 3D Iron Man Mark 85 armor & nanotech renderer safely
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctrl: ArmorOverlayController | null = null;
    try {
      ctrl = new ArmorOverlayController({
        canvas,
        getVideo: () => videoRef.current,
        getFrame: () => latestFrameRef.current,
        onTelemetry: setTelemetry,
      });
      controllerRef.current = ctrl;
      setWebglError('');
    } catch (err) {
      setWebglError(
        err instanceof Error
          ? `WebGL indisponible : ${err.message}`
          : 'Impossible d’initialiser le rendu 3D WebGL.',
      );
    }
    return () => {
      ctrl?.dispose();
      controllerRef.current = null;
    };
  }, [latestFrameRef, videoRef]);

  const wakeControls = useCallback(() => {
    setControlsAwake(true);
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setControlsAwake(false), 3200);
  }, []);

  useEffect(() => {
    wakeControls();
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    };
  }, [wakeControls]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const handleCopyUrl = useCallback(() => {
    if (!pageUrl || !navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(pageUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2200);
      })
      .catch(() => {});
  }, [pageUrl]);

  const handleReplay = useCallback(() => {
    wakeControls();
    controllerRef.current?.replaySuitUp();
  }, [wakeControls]);

  const handleToggleSuit = useCallback(() => {
    wakeControls();
    controllerRef.current?.toggleSuit();
  }, [wakeControls]);

  const handleToggleVisor = useCallback(() => {
    wakeControls();
    controllerRef.current?.toggleVisor();
  }, [wakeControls]);

  const handleToggleSound = useCallback(() => {
    wakeControls();
    const next = !soundOn;
    setSoundOn(next);
    soundFx.setEnabled(next);
  }, [soundOn, wakeControls]);

  const handleFullscreen = useCallback(() => {
    wakeControls();
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }, [wakeControls]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (status !== 'ready') return;
      const k = ev.key.toLowerCase();
      if (k === 'r' || ev.code === 'Space') {
        ev.preventDefault();
        handleReplay();
      } else if (k === 'e') {
        handleToggleSuit();
      } else if (k === 'v') {
        handleToggleVisor();
      } else if (k === 'f') {
        handleFullscreen();
      } else if (k === 'm') {
        handleToggleSound();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleFullscreen, handleReplay, handleToggleSound, handleToggleSuit, handleToggleVisor, status]);

  const suitActive = telemetry.phase === 'equipped' || telemetry.phase === 'equipping';
  const statusBanner = webglError || trackerError;

  return (
    <main
      ref={stageRef}
      className="camera-stage"
      onPointerMove={wakeControls}
      onPointerDown={wakeControls}
    >
      {/* Fullscreen mirrored live webcam */}
      <video ref={videoRef} className="camera-video" playsInline muted autoPlay />

      {/* Fullscreen photorealistic 3D Iron Man Mark 85 nanotech overlay */}
      <canvas ref={canvasRef} className="armor-canvas" />

      {/* Subtle status pill while camera is live */}
      {status === 'ready' && (!trackerReady || statusBanner || !telemetry.bodyDetected) && (
        <div className="top-hint" role="status" aria-live="polite">
          <span className={`hint-dot ${statusBanner ? 'is-err' : !trackerReady ? 'is-wait' : 'is-scan'}`} />
          <span>
            {statusBanner
              ? statusBanner
              : !trackerReady
                ? 'Chargement de la détection corporelle…'
                : 'Placez-vous face à la caméra pour équiper l’armure'}
          </span>
        </div>
      )}

      {/* Initial camera activation screen (with automatic action buttons if browser pauses prompt) */}
      {status === 'starting' && (
        <div className="center-overlay">
          <div className="camera-prompt">
            <div className="spinner-ring" aria-hidden="true" />
            <h1 className="prompt-title">Iron Man Mark 85 — Activation Webcam</h1>
            <p className="prompt-text">
              Cliquez sur <strong>Autoriser</strong> dans la fenêtre de votre navigateur pour démarrer la caméra en plein écran.
            </p>
            {showStartActions && (
              <div className="prompt-actions">
                <button type="button" className="primary-action" onClick={() => void startCamera()}>
                  <Camera size={17} />
                  <span>Activer ma webcam</span>
                </button>
                {inIframe && pageUrl && (
                  <a
                    className="secondary-action"
                    href={pageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={15} />
                    <span>Ouvrir dans un nouvel onglet</span>
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Webcam permission / embedded-iframe unlock screen */}
      {status === 'error' && (
        <div className="center-overlay">
          <div className="camera-prompt">
            <div className="prompt-icon" aria-hidden="true">
              <Camera size={26} />
            </div>
            <h1 className="prompt-title">
              {errorKind === 'iframe-blocked'
                ? 'Activer votre Webcam PC'
                : errorKind === 'not-found'
                  ? 'Webcam introuvable'
                  : errorKind === 'in-use'
                    ? 'Webcam déjà utilisée'
                    : 'Autoriser votre Webcam'}
            </h1>
            <p className="prompt-text">{errorMessage}</p>

            <div className="prompt-actions">
              {errorKind === 'iframe-blocked' && pageUrl ? (
                <>
                  <a
                    className="primary-action"
                    href={pageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={17} />
                    <span>Ouvrir en plein onglet (activer la caméra)</span>
                  </a>
                  <div className="action-row">
                    <button type="button" className="secondary-action" onClick={handleCopyUrl}>
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      <span>{copied ? 'Lien copié !' : 'Copier le lien'}</span>
                    </button>
                    <button type="button" className="secondary-action" onClick={() => void startCamera()}>
                      <RefreshCw size={15} />
                      <span>Réessayer</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button type="button" className="primary-action" onClick={() => void startCamera()}>
                    <Camera size={17} />
                    <span>Activer ma webcam</span>
                  </button>
                  {pageUrl && errorKind === 'permission-denied' && (
                    <a
                      className="secondary-action"
                      href={pageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={15} />
                      <span>Ouvrir dans un nouvel onglet</span>
                    </a>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Discreet auto-fading floating triggers over the live fullscreen webcam */}
      {status === 'ready' && trackerReady && (
        <div className={`floating-dock ${controlsAwake ? 'is-awake' : 'is-idle'}`}>
          <button
            type="button"
            className="dock-btn dock-btn-primary"
            onClick={handleReplay}
            title="Rejouer la génération nanotech (Espace / R)"
          >
            <RotateCcw size={15} />
            <span>Nanotech</span>
          </button>

          <button
            type="button"
            className="dock-btn"
            onClick={handleToggleSuit}
            title="Rétracter ou équiper l’armure (E ou touchez votre torse)"
          >
            {suitActive ? <ShieldOff size={15} /> : <Shield size={15} />}
            <span>{suitActive ? 'Rétracter' : 'Équiper'}</span>
          </button>

          <button
            type="button"
            className="dock-btn"
            onClick={handleToggleVisor}
            title="Ouvrir ou fermer le masque (V)"
          >
            {telemetry.visorOpen ? <Eye size={15} /> : <EyeOff size={15} />}
            <span>{telemetry.visorOpen ? 'Fermer masque' : 'Ouvrir masque'}</span>
          </button>

          {cameras.length > 1 && (
            <button
              type="button"
              className="dock-icon"
              onClick={cycleCamera}
              title="Changer de webcam"
              aria-label="Changer de webcam"
            >
              <SwitchCamera size={16} />
            </button>
          )}

          <button
            type="button"
            className={`dock-icon ${soundOn ? 'is-on' : ''}`}
            onClick={handleToggleSound}
            title={soundOn ? 'Couper le son (M)' : 'Activer le son (M)'}
            aria-label={soundOn ? 'Couper le son' : 'Activer le son'}
          >
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>

          <button
            type="button"
            className="dock-icon"
            onClick={handleFullscreen}
            title={isFullscreen ? 'Quitter le plein écran (F)' : 'Plein écran (F)'}
            aria-label={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      )}
    </main>
  );
}
