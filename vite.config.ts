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
    // 供 PWA 的 Service Worker 在 install 时枚举全部 chunk（含动态 chunk），
    // 保证"第一次在线访问后断网"也能启动；文件名固定，不参与 hash 缓存。
    manifest: 'asset-manifest.json',
    // 拆包之后单块应显著小于此值；保留 1200KB 只是给 three/codemirror 这类
    // 上游单体库留余量，不再用它掩盖"什么都在一个 chunk 里"的问题。
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        portal: fileURLToPath(new URL('./portal.html', import.meta.url)),
      },
      output: {
        // 稳定拆包：three / CodeMirror 只在真正用到它们的界面按需加载，
        // React 与状态层独立缓存，升级业务代码时不必让用户重下大依赖。
        // 只按 node_modules 路径分类，业务代码仍由 Rollup 自动分块。
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](three|three[\\/])/.test(id)) return 'vendor-three'
          if (/[\\/]node_modules[\\/](@codemirror|codemirror|@lezer)[\\/]/.test(id)) return 'vendor-codemirror'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'vendor-zod'
          if (/[\\/]node_modules[\\/](immer|zustand)[\\/]/.test(id)) return 'vendor-state'
          return 'vendor'
        },
      },
    },
  },
})
