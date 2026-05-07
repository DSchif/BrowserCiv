import { defineConfig } from "vite";

const backendProxy = {
  target: "http://localhost:8787",
  changeOrigin: true,
};

const simProxy = {
  target: "http://localhost:3334",
  changeOrigin: true,
};

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/matches": backendProxy,
      "/account": backendProxy,
      "/admin": backendProxy,
      "/content-pack": backendProxy,
      "/health": backendProxy,
      "/ws": { ...backendProxy, ws: true },
      "/sim": simProxy,
      "/agents": simProxy,
      "/runs": simProxy,
    },
  },
  preview: {
    port: 5173,
    proxy: {
      "/matches": backendProxy,
      "/account": backendProxy,
      "/admin": backendProxy,
      "/content-pack": backendProxy,
      "/health": backendProxy,
      "/ws": { ...backendProxy, ws: true },
      "/sim": simProxy,
      "/agents": simProxy,
      "/runs": simProxy,
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
