import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/desktop/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/desktop/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/desktop/renderer"),
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/desktop/renderer/index.html"),
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@renderer": resolve(import.meta.dirname, "src/desktop/renderer/src"),
      },
    },
  },
});
