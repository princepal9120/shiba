import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// TanStack Start's required router entry (src/router.tsx → getRouter).
export function getRouter() {
  // No basepath: routes already start at /app, and Start strips a basepath from the shell's output path.
  return createRouter({
    routeTree,
    // The shell SSRs only the root, so /app must first paint this exact markup or React logs #418.
    defaultPendingComponent: () => <div className="h-dvh" />,
    // "always" keeps query links inside the manifest scope of /app/.
    trailingSlash: "always",
  });
}
