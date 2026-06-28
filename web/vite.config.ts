import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes asset URLs relative so the build works under a GitHub Pages
// project subpath (https://user.github.io/repo/) without hardcoding the repo name.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
