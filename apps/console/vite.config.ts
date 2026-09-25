import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3200,
    proxy: {
      "/workflows": "http://127.0.0.1:3100",
      "/runs": "http://127.0.0.1:3100",
      "/api": "http://127.0.0.1:3100",
      "/metrics": "http://127.0.0.1:3100",
      "/workers": "http://127.0.0.1:3100",
      "/human-tasks": "http://127.0.0.1:3100",
      "/interactions": "http://127.0.0.1:3100",
      "/health": "http://127.0.0.1:3100",
      "/openapi.json": "http://127.0.0.1:3100",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
