import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  // 本地保持零重试（任何红都当红）；CI 的共享 runner 更慢，个别用例存在与加载时序有关的抖动，
  // 允许一次重试，避免 v0.4.0 新增的 49 条用例把偶发翻红带进发布流水线。
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'harness/out/playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5274',
    channel: 'chrome',
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--disable-lcd-text'] },
  },
  webServer: {
    command: 'node scripts/dev-server.mjs 5274',
    url: 'http://127.0.0.1:5274',
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
