import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5273,
    strictPort: true,
    host: '127.0.0.1',
    // 编辑器的原子写会产生 *.tmpdir 临时目录；不忽略会让 chokidar 抛 EBUSY 直接崩掉。
    watch: { ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**', '**/harness/**', '**/dist/**'] },
  },
  preview: { port: 5273, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 2500,
  },
})
