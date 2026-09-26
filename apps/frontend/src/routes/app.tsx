import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { App } from "../app";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeProvider } from "../components/ThemeProvider";

export const Route = createFileRoute("/app")({
  component: DashboardRoute,
});

function DashboardRoute() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <App />
        <Toaster theme="light" position="bottom-right" richColors />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
