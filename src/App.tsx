import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Aperture,
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Expand,
  Eye,
  Gauge,
  Hand,
  Layers3,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  ScanFace,
  Settings2,
  Shield,
  Sparkles,
  Video,
  X,
  Zap,
} from 'lucide-react';
import type { ArmorOverlay, OverlayOptions } from './ArmorOverlay';
import { useArmorTracking } from './useArmorTracking';

const INITIAL_OPTIONS: OverlayOptions = {
  armor: true,
  face: true,
  body: true,
  hands: true,
  effects: true,
  intensity: 1,
};

function App() {
  const { videoRef, frame, latestFrameRef, status, error, cpuMode, startCamera, stopCamera } = useArmorTracking();
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [paused, setPaused] = useState(false);
  const [rendererError, setRendererError] = useState('');
  const [cameraSize, setCameraSize] = useState({ width: 0, height: 0 });
  const [renderFps, setRenderFps] = useState(0);
  const overlayHostRef = useRef<HTMLDivElement>(null);
  const trackingCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<ArmorOverlay | null>(null);
  const optionsRef = useRef(options);
  const statusRef = useRef(status);
  const pausedRef = useRef(paused);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (status !== 'ready') return;
    const video = videoRef.current;
    if (!video) return;

    const updateSize = () => setCameraSize({ width: video.videoWidth, height: video.videoHeight });
    updateSize();
    video.addEventListener('loadedmetadata', updateSize);
    return () => video.removeEventListener('loadedmetadata', updateSize);
  }, [status, videoRef]);

  useEffect(() => {
    if (status !== 'ready') return;

    const host = overlayHostRef.current;
    if (!host) return;

    let overlay: ArmorOverlay | null = null;
    let animationFrame = 0;
    let disposed = false;
    let renderFrames = 0;
    let renderFpsStartedAt = 0;
    let observer: ResizeObserver | null = null;
    let resize = () => {};

    const initialize = async () => {
      try {
        const { ArmorOverlay } = await import('./ArmorOverlay');
        if (disposed) return;

        overlay = new ArmorOverlay();
        overlayRef.current = overlay;
        host.appendChild(overlay.renderer.domElement);

        const video = videoRef.current;
        resize = () =>
          overlay?.resize(
            host.clientWidth,
            host.clientHeight,
            video?.videoWidth || 1,
            video?.videoHeight || 1,
          );
        observer = new ResizeObserver(resize);
        observer.observe(host);
        video?.addEventListener('loadedmetadata', resize);
        resize();

        const render = (time: number) => {
          if (statusRef.current === 'ready' && !pausedRef.current) {
            if (renderFpsStartedAt === 0) renderFpsStartedAt = time;
            renderFrames += 1;
            const renderElapsed = time - renderFpsStartedAt;
            if (renderElapsed >= 1000) {
              setRenderFps(Math.round((renderFrames * 1000) / renderElapsed));
              renderFrames = 0;
              renderFpsStartedAt = time;
            }
            const currentFrame = latestFrameRef.current;
            const currentOptions = optionsRef.current;
            overlay?.update(
              currentFrame.pose,
              currentFrame.face,
              currentFrame.hands,
              currentFrame.openHands,
              currentOptions,
              time,
            );
            if (trackingCanvasRef.current) {
              overlay?.drawTracking(
                trackingCanvasRef.current,
                currentOptions,
              );
            }
          }
          animationFrame = requestAnimationFrame(render);
        };
        animationFrame = requestAnimationFrame(render);
      } catch (reason) {
        setRendererError(
          reason instanceof Error
            ? `Le rendu WebGL est indisponible : ${reason.message}`
            : 'Le rendu WebGL est indisponible. Activez l’accélération graphique de votre navigateur.',
        );
      }
    };

    void initialize();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      videoRef.current?.removeEventListener('loadedmetadata', resize);
      overlay?.dispose();
      overlayRef.current = null;
    };
  }, [status]);

  const detections = useMemo(
    () => [
      { label: 'Visage', count: frame.face.length > 0 ? '478' : '—', active: frame.face.length > 0, icon: ScanFace },
      { label: 'Corps', count: frame.pose.length > 0 ? '33' : '—', active: frame.pose.length > 0, icon: Activity },
      {
        label: 'Mains',
        count: frame.hands.length > 0 ? `${frame.hands.length} / 2` : '—',
        active: frame.hands.length > 0,
        icon: Hand,
      },
    ],
    [frame.face.length, frame.hands.length, frame.pose.length],
  );

  const toggleOption = (key: keyof Omit<OverlayOptions, 'intensity'>) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };

  const captureFrame = () => {
    const video = videoRef.current;
    const overlayCanvas = overlayHostRef.current?.querySelector('canvas');
    const trackingCanvas = trackingCanvasRef.current;
    if (!video || !overlayCanvas || video.readyState < 2) return;

    overlayRef.current?.prepareCapture();
    const output = document.createElement('canvas');
    output.width = video.videoWidth;
    output.height = video.videoHeight;
    const context = output.getContext('2d');
    if (!context) return;

    context.save();
    context.translate(output.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, output.width, output.height);
    context.drawImage(overlayCanvas, 0, 0, output.width, output.height);
    if (trackingCanvas) context.drawImage(trackingCanvas, 0, 0, output.width, output.height);
    context.restore();

    const link = document.createElement('a');
    link.download = `armor-lab-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.href = output.toDataURL('image/png');
    link.click();
  };

  const toggleFullscreen = async () => {
    const stage = document.querySelector('.camera-stage');
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      setRendererError('Le mode plein écran n’a pas pu démarrer dans ce navigateur.');
    }
  };

  const detectionCount = Number(frame.face.length > 0) + Number(frame.pose.length > 0) + frame.hands.length;
  const trackingReady = status === 'ready' && detectionCount > 0;
  const repulsorReady = frame.openHands.some(Boolean);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Armor Lab accueil">
          <div className="brand-mark"><Aperture size={19} strokeWidth={1.8} /></div>
          <span className="brand-name">ARMOR<span>LAB</span></span>
          <span className="brand-divider" />
          <span className="workspace-label">VFX STUDIO <span className="workspace-dot" /></span>
        </a>
        <div className="topbar-center">
          <div className={`session-status ${status === 'ready' ? 'is-live' : ''}`}>
            <span className="status-dot" />
            {status === 'ready' ? 'SESSION ACTIVE' : status === 'loading' ? 'INITIALISATION…' : 'SESSION HORS LIGNE'}
          </div>
          <span className="topbar-separator" />
          <span className="project-name">Untitled project <ChevronDown size={13} /></span>
        </div>
        <div className="topbar-actions">
          <button className="icon-button help-button" aria-label="Aide" title="Aide"><CircleHelp size={17} /></button>
          <button className="export-button" onClick={captureFrame} disabled={status !== 'ready'}>
            <Download size={15} /> <span>Exporter</span>
          </button>
          <div className="avatar">A</div>
        </div>
      </header>

      <div className="workspace">
        <nav className="tool-rail" aria-label="Outils">
          <button className="rail-button active" aria-label="Studio" title="Studio"><Aperture size={18} /></button>
          <button className="rail-button" aria-label="Caméra" title="Caméra"><Video size={18} /></button>
          <button className="rail-button" aria-label="Couches" title="Couches"><Layers3 size={18} /></button>
          <div className="rail-spacer" />
          <button className="rail-button" aria-label="Paramètres" title="Paramètres"><Settings2 size={18} /></button>
          <div className="rail-version">V 1.0</div>
        </nav>

        <section className="editor">
          <div className="editor-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> REAL-TIME COMPOSITING</div>
              <h1>Armor <span>studio</span></h1>
              <p className="page-description">Votre scène. Votre armure. En temps réel.</p>
            </div>
            <div className="heading-tools">
              <div className="scene-chip"><span className="scene-chip-dot" /> SCÈNE 01</div>
              <span className="tool-separator" />
              <button className="icon-button" aria-label="Réinitialiser les effets" onClick={() => setOptions(INITIAL_OPTIONS)} title="Réinitialiser">
                <RotateCcw size={16} />
              </button>
              <button className="icon-button" aria-label="Plein écran" onClick={toggleFullscreen} title="Plein écran">
                <Maximize2 size={16} />
              </button>
            </div>
          </div>

          <div className="camera-stage">
            <div className="camera-feed">
              <video ref={videoRef} autoPlay muted playsInline aria-label="Flux de la webcam" />
              <div ref={overlayHostRef} className="three-host" />
              <canvas ref={trackingCanvasRef} className="tracking-canvas" />
            </div>

            {status !== 'ready' && (
              <div className={`camera-welcome ${status === 'error' ? 'has-error' : ''}`}>
                <div className="welcome-orbit orbit-one" />
                <div className="welcome-orbit orbit-two" />
                <div className="welcome-symbol"><Shield size={29} strokeWidth={1.25} /></div>
                <div className="welcome-kicker">{status === 'loading' ? 'CHARGEMENT DES MODÈLES' : 'STUDIO DE RÉALITÉ AUGMENTÉE'}</div>
                <h2>{status === 'loading' ? 'Préparation de votre scène' : 'Prêt à passer en armure ?'}</h2>
                <p>
                  {status === 'loading'
                    ? 'La caméra et les modèles de détection se préparent dans votre navigateur.'
                    : 'Activez votre caméra pour suivre votre visage, votre corps et vos mains.'}
                </p>
                {error && <div className="error-banner"><X size={14} /> {error}</div>}
                {status !== 'loading' && (
                  <button className="start-button" onClick={startCamera}>
                    <Camera size={16} /> Activer la caméra <span className="button-arrow">↗</span>
                  </button>
                )}
                <div className="welcome-privacy"><div className="privacy-lock">⌑</div> TRAITEMENT LOCAL · AUCUNE VIDÉO ENVOYÉE</div>
              </div>
            )}

            {status === 'ready' && (
              <>
                <div className="stage-topline">
                  <div className="live-tag"><span className="status-dot" /> LIVE</div>
                  <div className="tracking-tag"><span className={`tracking-dot ${trackingReady ? 'found' : ''}`} /> {trackingReady ? 'SUJET DÉTECTÉ' : 'RECHERCHE DU SUJET'}</div>
                </div>
                <div className={`repulsor-hint ${repulsorReady ? 'armed' : ''}`}>
                  <Zap size={12} /> {repulsorReady ? 'RÉPULSEUR · TIR' : 'OUVREZ LA MAIN POUR TIRER'}
                </div>
                <div className="stage-corner top-left" />
                <div className="stage-corner top-right" />
                <div className="stage-corner bottom-left" />
                <div className="stage-corner bottom-right" />
                {!trackingReady && (
                  <div className="searching-note"><ScanFace size={15} /> Placez-vous face à la caméra</div>
                )}
                <div className="stage-bottomline">
                  <span title="FPS de rendu WebGL et cadence réelle de l’inférence MediaPipe dans le Worker">
                    <span className="fps-dot" /> WEBGL {renderFps || '—'} · IA {frame.fps || '—'} FPS
                  </span>
                  <span>{cameraSize.width || '—'} × {cameraSize.height || '—'} <i /> FRONT CAMERA</span>
                </div>
              </>
            )}

            {rendererError && <div className="error-banner renderer-error">{rendererError}</div>}

            <div className="stage-controls">
              {status === 'ready' ? (
                <button className="stage-control" onClick={() => setPaused((value) => !value)} aria-label={paused ? 'Reprendre' : 'Mettre en pause'}>
                  {paused ? <Play size={15} /> : <Pause size={15} />}
                </button>
              ) : null}
              <button className="stage-control" onClick={toggleFullscreen} aria-label="Plein écran"><Expand size={15} /></button>
            </div>
          </div>

          <div className="metrics-row">
            <div className="metric-card">
              <div className="metric-icon"><Gauge size={16} /></div>
              <div className="metric-copy"><span>WEBGL RENDER</span><strong>{renderFps || '—'} <small>FPS</small></strong></div>
              <div className="metric-graph"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
            </div>
            <div className="metric-card">
              <div className="metric-icon cyan"><Activity size={16} /></div>
              <div className="metric-copy"><span>TRACKING</span><strong>{trackingReady ? 'Actif' : status === 'ready' ? 'Recherche' : 'En attente'}</strong></div>
              <div className={`metric-live ${trackingReady ? 'on' : ''}`}><span /> {trackingReady ? 'LIVE' : '—'}</div>
            </div>
            <div className="metric-card detection-metric">
              <div className="metric-icon gold"><ScanFace size={16} /></div>
              <div className="metric-copy"><span>DÉTECTIONS</span><strong>{frame.face.length > 0 || frame.pose.length > 0 ? '01' : '00'} <small>SUJET</small></strong></div>
              <div className="detection-stack"><span /><span /><span /></div>
            </div>
          </div>

          <div className="detection-list">
            <div className="section-label"><span>TRACKING EN DIRECT</span><span className="landmark-label">LANDMARKS</span></div>
            {detections.map(({ label, count, active, icon: Icon }) => (
              <div className="detection-row" key={label}>
                <div className={`detection-icon ${active ? 'detected' : ''}`}><Icon size={15} /></div>
                <span className="detection-name">{label}</span>
                <span className={`detection-state ${active ? 'detected' : ''}`}>{active ? 'DÉTECTÉ' : 'EN ATTENTE'}</span>
                <span className="detection-count">{count}</span>
                <div className={`detection-check ${active ? 'checked' : ''}`}>{active && <Check size={11} />}</div>
              </div>
            ))}
          </div>
        </section>

        <aside className="inspector">
          <div className="inspector-header">
            <div><span className="inspector-kicker">CONFIGURATION</span><h2>Propriétés</h2></div>
            <button className="icon-button" aria-label="Paramètres de propriété"><Settings2 size={16} /></button>
          </div>

          <section className="inspector-section">
            <div className="section-heading"><span>ARMURE</span><span className="section-count">01 / 04</span></div>
            <div className="armor-card">
              <div className="armor-preview">
                <div className="armor-preview-glow" />
                <div className="armor-hex"><Shield size={29} strokeWidth={1.1} /></div>
                <div className="armor-preview-line line-a" />
                <div className="armor-preview-line line-b" />
                <div className="armor-preview-tag">NOVA · 01</div>
                <div className="armor-preview-scan" />
              </div>
              <div className="armor-details">
                <div><span className="armor-name">NOVA-01</span><span className="armor-edition">EXO FRAME · V1</span></div>
                <button className="select-button" title="Armure sélectionnée"><Check size={13} /></button>
              </div>
            </div>
            <button className="browse-button"><span><Sparkles size={14} /> Explorer les armures</span><span>↗</span></button>
          </section>

          <section className="inspector-section layers-section">
            <div className="section-heading"><span>CALQUES VFX</span><button className="text-icon-button" aria-label="Ajouter un calque">+</button></div>
            {[
              { key: 'armor', label: 'Plaques d’armure', detail: 'Rendu 3D · suivi du corps', icon: Shield },
              { key: 'face', label: 'Visière & visage', detail: '478 points · maillage facial', icon: ScanFace },
              { key: 'hands', label: 'Répulseurs', detail: 'Suivi des mains · x2', icon: Hand },
              { key: 'effects', label: 'Effets lumineux', detail: 'Réacteur · halos · bloom', icon: Zap },
            ].map(({ key, label, detail, icon: Icon }) => {
              const isEnabled = options[key as keyof Omit<OverlayOptions, 'intensity'>];
              return (
                <button
                  className={`layer-row ${isEnabled ? '' : 'muted'}`}
                  key={key}
                  onClick={() => toggleOption(key as keyof Omit<OverlayOptions, 'intensity'>)}
                >
                  <span className="layer-icon"><Icon size={14} /></span>
                  <span className="layer-copy"><strong>{label}</strong><small>{detail}</small></span>
                  <span className={`switch ${isEnabled ? 'on' : ''}`}><i /></span>
                </button>
              );
            })}
            <button
              className={`layer-row tracking-layer ${options.body ? '' : 'muted'}`}
              onClick={() => toggleOption('body')}
            >
              <span className="layer-icon"><Eye size={14} /></span>
              <span className="layer-copy"><strong>Points de tracking</strong><small>Squelette & contours</small></span>
              <span className={`switch ${options.body ? 'on' : ''}`}><i /></span>
            </button>
          </section>

          <section className="inspector-section intensity-section">
            <div className="section-heading"><span>INTENSITÉ DES EFFETS</span><span className="intensity-value">{Math.round(options.intensity * 100)}%</span></div>
            <input
              aria-label="Intensité des effets"
              type="range"
              min="0.4"
              max="1.6"
              step="0.05"
              value={options.intensity}
              onChange={(event) => setOptions((current) => ({ ...current, intensity: Number(event.target.value) }))}
            />
            <div className="range-labels"><span>SUBTIL</span><span>INTENSE</span></div>
          </section>

          <div className="inspector-footer">
            <div className="engine-status"><span className="engine-dot" /><span>MOTEUR DE TRACKING</span><strong>{status === 'ready' ? (cpuMode ? 'CPU' : 'GPU') : 'PRÊT'}</strong></div>
            <button className="stop-camera-button" onClick={status === 'ready' ? stopCamera : startCamera} disabled={status === 'loading'}>
              {status === 'ready' ? <><X size={13} /> Arrêter la caméra</> : <><Camera size={13} /> {status === 'loading' ? 'Chargement…' : 'Démarrer la caméra'}</>}
            </button>
          </div>
        </aside>
      </div>
      <footer className="app-footer">
        <span><span className="footer-online" /> SYSTÈME OPÉRATIONNEL</span>
        <span>MediaPipe Vision <i /> Three.js <i /> 100% LOCAL</span>
        <span>ARMOR LAB <b>·</b> 2026</span>
      </footer>
    </main>
  );
}

export default App;
