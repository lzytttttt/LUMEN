import { expect, test } from '@playwright/test'
import { collectErrors, openApp } from './helpers'

test('播放：进入 → 翻页 → 总览 → 退出', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.play-root')).toBeVisible()
  await page.waitForTimeout(500)

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await expect(page.locator('.play-root')).toContainText('3 / 9')

  // 总览
  await page.keyboard.press('o')
  await page.waitForTimeout(400)
  const overviewTiles = await page.locator('.play-overview__cell').count()
  expect(overviewTiles).toBeGreaterThanOrEqual(9)
  await page.screenshot({ path: 'harness/out/e2e-play-overview.png' })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(page.locator('.play-root')).toBeVisible()

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await expect(page.locator('.play-root')).toHaveCount(0)
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()

  log.assertClean()
})

test('播放：黑屏与讲者视图入口不崩', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.play-root')).toBeVisible()
  await page.waitForTimeout(400)

  await page.keyboard.press('b')
  await page.waitForTimeout(350)
  await page.keyboard.press('b')
  await page.waitForTimeout(250)

  await page.keyboard.press('?')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'harness/out/e2e-play-help.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  log.assertClean()
})
