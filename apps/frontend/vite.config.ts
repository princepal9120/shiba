import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// PWA shell files live in public/app/ but must land in <outDir>/app/; the
// single publicDir (../web/public) can't cover both.
const PWA_SHELL_FILES = ["manifest.webmanifest", "apple-touch-icon.png", "icon-192.png"];
const PWA_MIME: Record<string, string> = {
  "manifest.webmanifest": "application/manifest+json",
  "apple-touch-icon.png": "image/png",
  "icon-192.png": "image/png",
};

export default defineConfig({
  root: rootDir,
  // The dashboard's favicon and og:image live only in apps/web/public.
  publicDir: resolve(rootDir, "../web/public"),
  build: {
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  environments: {
    // Start writes <build.outDir>/client and /server; only the client build
    // belongs in the Worker's assets dir (the server bundle stays in dist/).
    client: { build: { outDir: resolve(rootDir, "../../public") } },
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
    tanstackStart({
      // The Worker serves /app/ from public/app/index.html; the default shell is /_shell.html.
      spa: { enabled: true, maskPath: "/app", prerender: { outputPath: "/app/index" } },
    }),
    viteReact(),
    {
      name: "pwa-shell",
      applyToEnvironment: (env) => env.name === "client",
      generateBundle() {
        for (const name of PWA_SHELL_FILES) {
          this.emitFile({
            type: "asset",
            fileName: `app/${name}`,
            source: readFileSync(resolve(rootDir, "public", "app", name)),
          });
        }
      },
      // generateBundle never runs in dev, and publicDir is apps/web/public,
      // so /app/* 404s locally without this. Matched against the known list so
      // the dev URL is never used to build a path.
      configureServer(server) {
        server.middlewares.use("/app", (req, res, next) => {
          const name = (req.url ?? "/").split("?")[0];
          const file = PWA_SHELL_FILES.find((f) => `/${f}` === name);
          if (!file) {
            next();
            return;
          }
          res.writeHead(200, {
            "content-type": PWA_MIME[file] ?? "application/octet-stream",
          });
          res.end(readFileSync(resolve(rootDir, "public", "app", file)));
        });
      },
    },
  ],
});
