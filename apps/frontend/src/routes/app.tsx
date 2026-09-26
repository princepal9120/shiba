import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { App } from "../app";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeProvider, useTheme } from "../components/ThemeProvider";

export const Route = createFileRoute("/app")({
  component: DashboardRoute,
});

function DashboardRoute() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <App />
        <ThemedToaster />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="bottom-right"
      richColors
    />
  );
}
