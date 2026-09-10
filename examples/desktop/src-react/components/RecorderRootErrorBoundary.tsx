import React from 'react';

type RecorderRootErrorBoundaryProps = {
  children: React.ReactNode;
};

type RecorderRootErrorBoundaryState = {
  errorMessage: string | null;
};

export class RecorderRootErrorBoundary extends React.Component<
  RecorderRootErrorBoundaryProps,
  RecorderRootErrorBoundaryState
> {
  public constructor(props: RecorderRootErrorBoundaryProps) {
    super(props);
    this.state = {
      errorMessage: null,
    };
  }

  public static getDerivedStateFromError(error: unknown): RecorderRootErrorBoundaryState {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  public componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('[shadow-recorder][renderer-root] render failed', message, info.componentStack);
  }

  public render(): React.ReactNode {
    if (!this.state.errorMessage) {
      return this.props.children;
    }

    return (
      <main className="layout">
        <section className="workspace-shell workspace-shell-mvp">
          <section className="panel root-error-panel">
            <div className="root-error-copy">
              <h1>主界面加载失败</h1>
              <p>
                这通常是 renderer 在渲染主页面时遇到了未处理异常。错误信息已经写入
                Electron 日志，可直接据此继续排查。
              </p>
            </div>
            <pre className="root-error-message">{this.state.errorMessage}</pre>
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  window.location.reload();
                }}
              >
                重新加载主界面
              </button>
            </div>
          </section>
        </section>
      </main>
    );
  }
}
