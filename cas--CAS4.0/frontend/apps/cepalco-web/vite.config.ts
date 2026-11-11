import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api/cepalco": {
        target: "http://127.0.0.1:4102",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/cepalco/, ""),
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
