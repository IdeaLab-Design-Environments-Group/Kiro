import { defineConfig } from "vite";
import { resolve } from "node:path";
import { coffeePlugin } from "./scripts/vite-plugin-coffee.js";

// Relative base so the built site works under any path (static host, GitHub
// Pages project page, or file://-style preview). Override with VITE_BASE.
//
// The transferred AKDE creation pipeline lives under `kirigami/` and the FKLD
// format lib under `fkld/` (CoffeeScript, like the FOLD reference library), so
// we register the coffee loader and the `@kirigami` / `@fkld` aliases AKDE uses.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  plugins: [coffeePlugin()],
  resolve: {
    alias: {
      "@kirigami": resolve(__dirname, "kirigami"),
      "@fkld": resolve(__dirname, "fkld"),
    },
  },
  server: { open: true },
  build: { outDir: "dist", emptyOutDir: true },
});
