import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
