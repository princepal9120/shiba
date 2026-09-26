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
          className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-[#f6f4ed] text-[#222320] p-6 text-center"
        >
          <p className="text-lg font-semibold">Something went wrong.</p>
          <p className="text-sm text-[#6a6f63] max-w-md break-words">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="px-4 py-2 rounded-none text-sm font-medium bg-[#0000a8] text-white hover:bg-[#1c1cc8] transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
