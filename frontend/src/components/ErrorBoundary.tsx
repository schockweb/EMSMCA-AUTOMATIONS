/**
 * ErrorBoundary — Global crash catcher for the React app.
 * Catches render errors, unhandled promise rejections, and runtime errors.
 * Reports all crashes to the backend POST /api/crashes endpoint.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import axios from 'axios';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  crashId: string | null;
  errorMessage: string;
}

/** Fire-and-forget crash reporter — works even without auth */
function reportCrash(payload: {
  error_type: string;
  message: string;
  stacktrace?: string;
  endpoint?: string;
  severity?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('access_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Use raw axios to avoid interceptor loops
    axios.post('/api/crashes', {
      error_type: payload.error_type,
      message: payload.message.slice(0, 2000),
      stacktrace: (payload.stacktrace || '').slice(0, 10000),
      endpoint: payload.endpoint || window.location.pathname,
      severity: payload.severity || 'error',
      metadata: {
        ...payload.metadata,
        user_agent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
    }, { headers }).catch(() => {
      // Silently fail — can't crash the crash reporter
    });
  } catch {
    // Guard against any sync errors
  }
}

export { reportCrash };

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, crashId: null, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, errorMessage: error.message || 'Unknown error' };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportCrash({
      error_type: error.name || 'ReactRenderError',
      message: error.message,
      stacktrace: `${error.stack || ''}\n\nComponent Stack:\n${errorInfo.componentStack || ''}`,
      severity: 'critical',
      metadata: { component_stack: errorInfo.componentStack },
    });
  }

  componentDidMount() {
    // Catch unhandled JS errors
    window.onerror = (message, source, lineno, colno, error) => {
      reportCrash({
        error_type: error?.name || 'WindowError',
        message: String(message),
        stacktrace: error?.stack || `at ${source}:${lineno}:${colno}`,
        severity: 'error',
        metadata: { source, lineno, colno },
      });
    };

    // Catch unhandled promise rejections
    window.onunhandledrejection = (event: PromiseRejectionEvent) => {
      const error = event.reason;
      reportCrash({
        error_type: error?.name || 'UnhandledPromiseRejection',
        message: error?.message || String(error),
        stacktrace: error?.stack || '',
        severity: 'error',
        metadata: { reason: String(error) },
      });
    };
  }

  handleRecover = () => {
    this.setState({ hasError: false, crashId: null, errorMessage: '' });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
          fontFamily: "'Inter', 'Segoe UI', sans-serif",
          padding: 24,
        }}>
          <div style={{
            maxWidth: 520,
            width: '100%',
            background: 'rgba(30, 41, 59, 0.8)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 24,
            padding: '48px 40px',
            textAlign: 'center',
            boxShadow: '0 0 80px rgba(239, 68, 68, 0.15), 0 25px 50px rgba(0,0,0,0.3)',
          }}>
            {/* Crash Icon */}
            <div style={{
              width: 80, height: 80, margin: '0 auto 24px',
              background: 'rgba(239, 68, 68, 0.15)',
              borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'pulse 2s infinite',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>

            <h1 style={{
              fontSize: '1.75rem', fontWeight: 800, color: '#f1f5f9',
              margin: '0 0 12px', letterSpacing: '-0.02em',
            }}>
              Something went wrong
            </h1>
            <p style={{
              fontSize: '1rem', color: '#94a3b8', margin: '0 0 8px', lineHeight: 1.6,
            }}>
              An unexpected error crashed this page. Our monitoring system has been automatically notified.
            </p>
            <p style={{
              fontSize: '0.85rem', color: '#64748b', margin: '0 0 32px',
              fontFamily: 'monospace', wordBreak: 'break-all',
            }}>
              {this.state.errorMessage}
            </p>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={this.handleRecover}
                style={{
                  background: 'linear-gradient(135deg, #0d9488, #0f766e)',
                  color: 'white', border: 'none', padding: '14px 32px',
                  borderRadius: 14, fontWeight: 700, fontSize: '1rem',
                  cursor: 'pointer', transition: 'all 0.2s',
                  boxShadow: '0 4px 15px rgba(13, 148, 136, 0.3)',
                }}
                onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
              >
                Return to Dashboard
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  background: 'rgba(255,255,255,0.08)', color: '#e2e8f0',
                  border: '1px solid rgba(255,255,255,0.15)', padding: '14px 28px',
                  borderRadius: 14, fontWeight: 600, fontSize: '1rem',
                  cursor: 'pointer', transition: 'all 0.2s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
