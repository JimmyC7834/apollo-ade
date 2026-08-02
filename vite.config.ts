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
    /*
     * SPIKE — delete with `rm -r src/spike`. See
     * docs/wayfinder/pi-harness/tickets/12-walking-skeleton.md.
     *
     * The API key is attached here, in the Node process, so it never reaches
     * the browser and never enters the build output the way an
     * `import.meta.env` value would. Dev-only by construction: there is no
     * Vite server in a packaged build.
     *
     * This is NOT the credential design. Ticket 06 puts the HTTPS call in
     * Rust, and the thing it most wants tested — streamed bytes crossing the
     * Tauri IPC — this deliberately does not exercise. It exists so the event
     * contract and ExecutionEnv can be falsified without the credential path
     * as a second variable.
     */
    proxy: {
      "/spike-deepseek": {
        target: "https://api.deepseek.com",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/spike-deepseek/, ""),
        configure: (proxy: {
          on: (event: string, handler: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void;
        }) => {
          proxy.on("proxyReq", (proxyReq) => {
            // @ts-expect-error process is a nodejs global
            const key = process.env.DEEPSEEK_API_KEY;
            if (key) {
              proxyReq.setHeader("Authorization", `Bearer ${key}`);
            }
          });
        },
      },
    },
  },
}));
