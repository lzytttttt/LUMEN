import { expect, test } from '@playwright/test'
import { collectErrors, openApp } from './helpers'

test('打印视图：9 页、3D 已换成静态图、PDF 页数一致', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/?print=1', { waitUntil: 'networkidle' })
  await expect(page.locator('[data-print-page]')).toHaveCount(9, { timeout: 40_000 })
  await page.waitForTimeout(1500)

  const canvases = await page.locator('[data-print-page] canvas').count()
  expect(canvases).toBe(0)

  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  expect(pageCount).toBe(9)
  await page.screenshot({ path: 'harness/out/e2e-print.png' })

  log.assertClean()
})
