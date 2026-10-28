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
    // 编辑器的原子写会产生 *.tmpdir 临时目录；被其它进程短暂锁定的文档（如 LICENSE*.txt）
    // 也会让 chokidar 抛 EBUSY 直接崩掉，一并忽略。
    watch: {
      ignored: [
        '**/*.tmpdir/**',
        '**/.*.tmpdir/**',
        '**/harness/**',
        '**/dist/**',
        '**/LICENSE*.txt',
      ],
    },
  },
  preview: { port: 5273, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        portal: fileURLToPath(new URL('./portal.html', import.meta.url)),
      },
    },
  },
})
