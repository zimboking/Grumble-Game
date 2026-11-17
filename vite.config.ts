import { defineConfig } from 'vite';

// Relative base so the site works under https://<user>.github.io/<repo>/
// without hard-coding the repo name. Routing is hash based.
export default defineConfig({
  base: './',
  build: { target: 'es2019' },
});
