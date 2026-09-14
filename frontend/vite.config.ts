import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
//
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      "/api/agent": {
        target: "http://127.0.0.1:8545",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/agent/, ""),
      },
      "/api/pyth": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pyth/, "/price"),
      },
    },
  },
})
