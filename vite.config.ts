import { defineConfig } from "vite";

// Relative base so the built site works under any path (static host, GitHub
// Pages project page, or file://-style preview). Override with VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  server: { open: true },
  build: { outDir: "dist", emptyOutDir: true },
});
