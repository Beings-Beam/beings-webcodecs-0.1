import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    open: '/manual-test.html'
  },
  build: {
    outDir: 'dist',
    lib: {
      entry: 'src/index.ts',
      formats: ['es']
    }
  },
  worker: {
    format: 'es',
    plugins: []
  },
  optimizeDeps: {
    exclude: ['mp4-muxer', 'webm-muxer']
  }
})
