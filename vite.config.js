import { defineConfig } from 'vite';

// GitHub Pages serves a project repo from /<repo>/, so the built asset paths
// have to carry that prefix. Without it every asset 404s and the page comes up
// blank with nothing in the console to explain why.
export default defineConfig({
  base: process.env.KERBSIDE_BASE ?? '/',
});
