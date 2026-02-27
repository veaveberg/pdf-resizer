import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from 'vite-plugin-svgr';

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.TAURI_BUILD ? "/" : "/pdf-resizer/",
  plugins: [react(), svgr()],
  publicDir: "./public",
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs_worker: ["pdfjs-dist/build/pdf.worker.mjs"],
        },
      },
    },
  },

  // Vite optons tailored for Tauri developemnt and only applied in `tauri dev` or `tauri build`
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
      // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
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
