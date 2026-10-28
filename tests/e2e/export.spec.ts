import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectErrors, openApp } from './helpers'

const OUT = path.resolve('harness/out/export')
mkdirSync(OUT, { recursive: true })

test('导出：独立 HTML 在 file:// 下可播、零外部请求', async ({ page, context }) => {
  const log = collectErrors(page)
  await openApp(page)

  await page.getByRole('button', { name: /^导出$|导出$/ }).first().click()
  await expect(page.locator('.lm-modal')).toBeVisible()
  const standaloneTab = page.getByRole('tab', { name: /独立 HTML|Standalone/ }).first()
  if (await standaloneTab.count()) await standaloneTab.click()
  await page.waitForTimeout(300)

  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })
  await page.getByRole('button', { name: /生成文件|Build file/ }).first().click()
  const download = await downloadPromise
  const file = path.join(OUT, 'e2e-standalone.html')
  await download.saveAs(file)
  log.assertClean()

  const player = await context.newPage()
  const playerErrors: string[] = []
  const external: string[] = []
  player.on('console', (message) => {
    if (message.type() === 'error') playerErrors.push(message.text())
  })
  player.on('pageerror', (error) => playerErrors.push(String(error)))
  player.on('request', (request) => {
    const url = request.url()
    if (/^https?:/i.test(url)) external.push(url)
  })

  await player.goto(pathToFileURL(file).href, { waitUntil: 'load' })
  await player.waitForSelector('.lumen-slide', { timeout: 20_000 })
  await player.waitForTimeout(1200)
  const coverText = await player.locator('.lumen-slide').first().innerText()
  expect(coverText).toContain('该换一种载体')
  expect(external).toHaveLength(0)
  expect(playerErrors, playerErrors.join('\n')).toHaveLength(0)

  await player.screenshot({ path: path.join(OUT, 'e2e-standalone-cover.png') })
  for (let i = 0; i < 8; i += 1) {
    await player.keyboard.press('ArrowRight')
    await player.waitForTimeout(520)
  }
  await player.screenshot({ path: path.join(OUT, 'e2e-standalone-last.png') })
  await player.close()
})
