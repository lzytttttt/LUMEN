/**
 * vitest.security.config.ts —— 安全红队层独立配置（06 §5「安全」层，target < 2min）。
 *
 * 为什么不 merge `vitest.config.ts`：mergeConfig 会**拼接** include 数组，导致安全层混入单测；
 * 这里显式复制同一份解析配置（alias/react/setup），只把 include 换成 `tests/security/**`。
 * 由 `pnpm test:security`（task-11 接入 CI security job）或本命令执行：
 *   node node_modules/vitest/vitest.mjs run --config vitest.security.config.ts
 */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/security/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    globals: false,
    reporters: ['dot'],
    testTimeout: 15000,
  },
})
