import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  // GitHub Pages serves the static demo under /<repository>/.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5080",
        // Keep the browser's Host so the API's same-origin check (Origin vs Host) passes in dev.
        configure: (proxy) =>
          proxy.on("proxyReq", (request, original) => {
            if (original.headers.host)
              request.setHeader("host", original.headers.host);
          }),
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          react: ["react", "react-dom", "react-router-dom"],
          offline: ["dexie", "fflate"],
        },
      },
    },
  },
});
