import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      vue: resolve(import.meta.dirname, "ui/node_modules/vue"),
      // pinia 4 dropped the CJS build; pinia.js is the ESM entry it ships now.
      pinia: resolve(import.meta.dirname, "ui/node_modules/pinia/dist/pinia.js"),
    },
  },
  test: {
    exclude: ["dist/**", "**/node_modules/**"],
    deps: {
      inline: ["pinia"],
    },
  },
});
