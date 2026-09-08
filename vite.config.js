import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from 'vite-plugin-svgr';

// https://vitejs.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), svgr()],
  publicDir: "./public",

  // Options tailored for Tauri and applied only in `tauri dev` or `tauri build`.
  ...(process.env.TAURI_DEBUG || process.env.TAURI_BUILD
    ? {
      // prevent vite from obscuring rust errors
      clearScreen: false,
      // tauri expects a fixed port, fail if that port is not available
      server: {
        port: 1420,
        strictPort: true,
      },
      // to make use of `TAURI_DEBUG` and other env variables
      // https://v2.tauri.app/reference/config/#buildconfig
      envPrefix: ["VITE_", "TAURI_"],
      build: {
        // Tauri supports es2021
        target: ["es2021", "chrome100", "safari13"],
        // don't minify for debug builds
        minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
        // produce sourcemaps for debug builds
        sourcemap: !!process.env.TAURI_DEBUG,
      },
    }
    : {}),
});
