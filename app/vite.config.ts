import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vite";

// GitHub Pages serves the app from /<repo>/; keep base relative so the same
// build also works from a plain static server or `vite preview`.
export default defineConfig({
  base: "./",
  plugins: [react(), nodePolyfills({ protocolImports: true })],
});
