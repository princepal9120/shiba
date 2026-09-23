import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  // outDir is also named public/, so default publicDir would self-collide.
  publicDir: resolve(rootDir, "../web/public"),
  build: {
    outDir: resolve(rootDir, "../../public"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      // app/index.html → public/app/index.html; the worker serves the
      // dashboard under /app/ from the shared assets directory.
      input: ["app/index.html"],
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  server: {
    port: 5173,
    // Same-origin in prod; in dev the Worker runs on 8788 (8787 is often taken).
    proxy: {
      "/api": "http://localhost:8788",
      "/agents": { target: "http://localhost:8788", ws: true },
    },
    open: "/app/",
  },
  plugins: [
    {
      name: "root-redirect",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/" || req.url === "") {
            res.writeHead(302, { Location: "/app/" });
            res.end();
            return;
          }
          if (req.url === "/app" || req.url === "/app/") {
            req.url = "/app/index.html";
          }
          next();
        });
      },
    },
  ],
});
