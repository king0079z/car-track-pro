import React from 'react';
import { reportClientErrorCapture } from '../services/clientErrorReporter';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches React render errors, logs them to audit automatically, shows minimal recovery UI. */
export class ClientErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportClientErrorCapture({
      kind: 'react',
      message: error.message || 'React render error',
      stack: error.stack,
      component_stack: info.componentStack || undefined,
    });
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            margin: 24,
            padding: 28,
            borderRadius: 16,
            border: '1px solid rgba(248,113,113,0.35)',
            background: 'linear-gradient(165deg, var(--bg-surface), rgba(248,113,113,0.06))',
            maxWidth: 520,
          }}
        >
          <h2 style={{ margin: '0 0 10px', fontSize: 18, color: 'var(--text-primary)' }}>
            This view crashed
          </h2>
          <p style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            The error was <strong style={{ color: 'var(--text-primary)' }}>recorded automatically</strong> in{' '}
            <strong>Audit</strong> for administrators (<code style={{ fontSize: 12 }}>client_auto_error</code> · React).
          </p>
          <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
            {this.state.error.message}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={this.reload}>
              Reload page
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => (window.location.href = '/')}>
              Go to dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
