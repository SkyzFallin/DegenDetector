import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/poly": {
        target: "https://gamma-api.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/poly/, ""),
      },
      "/api/kalshi": {
        target: "https://api.elections.kalshi.com/trade-api/v2",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/kalshi/, ""),
      },
      "/api/clob": {
        target: "https://clob.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/clob/, ""),
      },
      "/api/telegram": {
        target: "https://api.telegram.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/telegram/, ""),
      },
    },
  },
});
