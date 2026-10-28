import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * 播放器内核构建：产出 public/player/lumen-player.js + .css（IIFE，自包含）。
 * 导出「独立 HTML」时由 src/export/standalone.ts 读取并内联。
 *
 * 关键 alias：`@/assets/assetStore` → `src/export/playerAssetBridge.ts`。
 * 单文件 HTML 里没有 IndexedDB 素材，图片以 assetId → dataURL 的内联表
 * （window.__LUMEN_ASSETS__）提供；这层桥让 useAssetUrl 优先查表。
 * 只影响本构建，编辑器构建仍然用真正的资产库。
 */
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@/assets/assetStore',
        replacement: fileURLToPath(new URL('./src/export/playerAssetBridge.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    target: 'es2022',
    outDir: 'public/player',
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: 'esbuild',
    lib: {
      entry: fileURLToPath(new URL('./src/player/entry.tsx', import.meta.url)),
      formats: ['iife'],
      name: 'LumenPlayer',
      fileName: () => 'lumen-player.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'lumen-player.[ext]',
      },
    },
  },
})
