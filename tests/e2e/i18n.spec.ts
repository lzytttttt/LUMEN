import { expect, test } from '@playwright/test'
import { collectErrors, openApp } from './helpers'

const CJK = /[\u4e00-\u9fa5]/

test('i18n：切到英文后工作台无中文；切回中文', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  await page.locator('button[aria-label="界面语言"], button[title="界面语言"]').first().click()
  await page.getByRole('button', { name: 'English' }).first().click()
  await page.waitForTimeout(500)

  const topbar = await page.locator('.topbar').innerText()
  expect(CJK.test(topbar)).toBe(false)
  await expect(page.getByRole('button', { name: /Insert/ }).first()).toBeVisible()
  await page.screenshot({ path: 'harness/out/e2e-en.png' })

  await page.locator('button[aria-label="Interface language"], button[title="Interface language"]').first().click()
  await page.getByRole('button', { name: '中文' }).first().click()
  await page.waitForTimeout(400)
  expect(CJK.test(await page.locator('.topbar').innerText())).toBe(true)

  log.assertClean()
})

test('持久化：刷新后仍是同一份演示（标题与幕数保留）', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  const title = page.locator('.topbar__title input').first()
  await title.fill('E2E 持久化测试')
  await title.press('Enter')
  await page.waitForTimeout(1200)

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(600)

  await expect(page.locator('.topbar__title input').first()).toHaveValue('E2E 持久化测试')
  expect(await page.locator('.rail__item').count()).toBe(9)
  log.assertClean()
})
