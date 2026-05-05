import { defineConfig } from "vite";

const backendProxy = {
  target: "http://localhost:8787",
  changeOrigin: true,
};

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/matches": backendProxy,
      "/content-pack": backendProxy,
      "/health": backendProxy,
      "/ws": { ...backendProxy, ws: true },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      "/matches": backendProxy,
      "/content-pack": backendProxy,
      "/health": backendProxy,
      "/ws": { ...backendProxy, ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
