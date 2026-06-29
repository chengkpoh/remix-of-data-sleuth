import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

// Standalone SPA build for the Electron desktop app.
// Outputs dist/index.html (+ assets) so electron/main.cjs can loadFile() it.
// This bypasses TanStack Start / Nitro entirely — the desktop app does not need SSR.
export default defineConfig({
  base: "./", // critical for file:// loading in Electron
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  root: path.resolve(__dirname, "electron"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "chrome120",
  },
});
