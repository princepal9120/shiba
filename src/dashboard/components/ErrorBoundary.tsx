import { Component, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error("Dashboard render error:", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-black text-[#e6edf3] p-6 text-center"
        >
          <p className="text-lg font-semibold">Something went wrong.</p>
          <p className="text-sm text-[#8b98a9] max-w-md break-words">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[#0B9F95] text-black hover:bg-[#2dd4bf] transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
