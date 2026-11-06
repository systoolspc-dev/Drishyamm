import { Component } from 'react';

/**
 * Catches render/lifecycle errors in the subtree so one bad page (a failed
 * data shape, a null deref in a chart, etc.) shows a recovery panel instead
 * of unmounting the whole app to a blank screen. React error boundaries must
 * be class components — there is no hook equivalent.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep a console trail for support; wire to Sentry/console pipeline later.
    console.error('[ErrorBoundary] uncaught render error:', error, info?.componentStack);
  }

  handleReload = () => {
    // Clear the error first so a transient failure can recover without a full
    // reload; fall back to reload if the same subtree throws again.
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: 'var(--app-vh)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0e1a',
          color: '#e5e7eb',
          padding: 24,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong on this screen
          </h1>
          <p style={{ fontSize: 14, color: '#9ca3af', marginBottom: 20 }}>
            The rest of the app is unaffected. Try again, or reload if it keeps
            happening.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              onClick={this.handleReload}
              style={{
                background: '#F7983A', color: '#0a0e1a', border: 'none',
                borderRadius: 8, padding: '10px 18px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: 'transparent', color: '#e5e7eb',
                border: '1px solid #374151', borderRadius: 8,
                padding: '10px 18px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              Reload app
            </button>
          </div>
          {import.meta.env.DEV && (
            <pre style={{
              marginTop: 20, textAlign: 'left', fontSize: 12, color: '#f87171',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {String(error?.stack || error)}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
