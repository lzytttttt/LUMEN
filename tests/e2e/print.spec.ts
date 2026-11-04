import { expect, test } from '@playwright/test'
import { collectErrors } from './helpers'

test('打印视图：9 页、3D 已换成静态图、PDF 页数一致', async ({ page }) => {
  const log = collectErrors(page)

  // `?print=1` 路由在就绪后会自己调用 window.print()（PrintHost 的真实行为）。
  // 无头 Chrome 里这会让 CDP 的 page.pdf() 撞上 "Page is already being printed"，
  // 属于打印任务与 PDF 导出的竞态而不是页面缺陷。这里把 window.print 换成计数器：
  // 既保留「打印被触发」的断言，又让 PDF 导出可确定性执行。
  await page.addInitScript(() => {
    const scope = window as unknown as { __printCalls?: number }
    scope.__printCalls = 0
    window.print = () => {
      scope.__printCalls = (scope.__printCalls ?? 0) + 1
    }
  })

  await page.goto('/?print=1', { waitUntil: 'networkidle' })
  await expect(page.locator('[data-print-page]')).toHaveCount(9, { timeout: 40_000 })
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __printCalls?: number }).__printCalls ?? 0), {
      timeout: 30_000,
      message: '打印路由应调用一次 window.print()',
    })
    .toBeGreaterThan(0)
  await page.waitForTimeout(1500)

  const canvases = await page.locator('[data-print-page] canvas').count()
  expect(canvases).toBe(0)

  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  expect(pageCount).toBe(9)
  await page.screenshot({ path: 'harness/out/e2e-print.png' })

  log.assertClean()
})
