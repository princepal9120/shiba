import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./app";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./components/ThemeProvider";
import "./styles.css";

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
