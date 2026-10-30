import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function devStyleSrcPlugin(): Plugin {
  return {
    name: 'dev-style-src-unsafe-inline',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "style-src 'self'",
        "style-src 'self' 'unsafe-inline'",
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devStyleSrcPlugin()],
  build: {
    outDir: 'dist-react',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
