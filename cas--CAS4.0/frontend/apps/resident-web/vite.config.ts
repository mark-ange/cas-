import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api/resident": {
        target: "http://127.0.0.1:4101",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/resident/, ""),
        configure: proxy => proxy.on("proxyReq", proxyReq => proxyReq.removeHeader("origin")),
      },
      "/api/cepalco": {
        target: "http://127.0.0.1:4102",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/cepalco/, ""),
        configure: proxy => proxy.on("proxyReq", proxyReq => proxyReq.removeHeader("origin")),
      },
      "/api/water": {
        target: "http://127.0.0.1:4103",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/water/, ""),
        configure: proxy => proxy.on("proxyReq", proxyReq => proxyReq.removeHeader("origin")),
      },
    },
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        "../../..",
      ],
    },
  },
});
