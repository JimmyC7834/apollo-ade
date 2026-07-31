import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    // 1420/1421 fall inside a Windows-reserved TCP port range on some
    // machines. 5180 is taken by the sibling agent-window prototype.
    port: 5190,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 5191 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
