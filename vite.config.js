import { defineConfig } from 'vite'

// Relative base so the same build works on GitHub Pages project sites
// (https://user.github.io/Barkfart/) and locally via file/preview.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Fully static; no SSR or server chunks
    target: 'es2020',
  },
})
