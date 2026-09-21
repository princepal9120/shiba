import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // outDir is also named public/, so default publicDir would self-collide.
  publicDir: "web/public",
  build: {
    outDir: "public",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      // app/index.html → public/app/index.html; dashboard source lives in
      // src/dashboard/ so shadscan's src/** scope sees it.
      input: ["app/index.html"],
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  server: {
    port: 5173,
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
