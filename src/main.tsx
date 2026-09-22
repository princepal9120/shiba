import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./dashboard/app";
import { ErrorBoundary } from "./dashboard/components/ErrorBoundary";
import { ThemeProvider } from "./dashboard/components/ThemeProvider";
import "./dashboard/styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element.");
}
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
        <Toaster theme="light" position="bottom-right" richColors />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
