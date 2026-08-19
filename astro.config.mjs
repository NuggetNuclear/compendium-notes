import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://compendium-notes.vercel.app',
  integrations: [
    react(),
    sitemap(),
  ],
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    },
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    // mathjax-full's version.js falls back to `eval('require')` to read its own
    // package.json unless this global is predefined — its own build tooling
    // (webpack DefinePlugin) sets it, and without it the fallback crashes in
    // the browser, where `require` doesn't exist.
    define: {
      PACKAGE_VERSION: JSON.stringify('3.2.1'),
    },
  },
});
