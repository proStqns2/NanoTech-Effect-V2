import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

type BoundaryState = { error: string | null };

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(err: unknown): BoundaryState {
    return { error: err instanceof Error ? err.message : 'Erreur d’affichage inattendue.' };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="center-overlay">
          <div className="camera-prompt">
            <h1 className="prompt-title">Rechargement nécessaire</h1>
            <p className="prompt-text">{this.state.error}</p>
            <button
              type="button"
              className="primary-action"
              onClick={() => window.location.reload()}
            >
              Recharger l’application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
