import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      vue: resolve(import.meta.dirname, "ui/node_modules/vue"),
      pinia: resolve(import.meta.dirname, "ui/node_modules/pinia/dist/pinia.cjs"),
    },
  },
  test: {
    exclude: ["dist/**", "**/node_modules/**"],
    deps: {
      inline: ["pinia"],
    },
  },
});
