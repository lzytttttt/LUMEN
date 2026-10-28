import { expect, test } from '@playwright/test'
import { collectErrors } from './helpers'

/** 造幕台的两个"非顶栏"入口：空幕 CTA、幕栏「+」长按 400ms。 */
test('入口：空幕 CTA 与幕栏「+」长按都能进造幕台', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/?onboard=0', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })

  // 短按「+」= 新建空白幕（不动造幕台）
  await page.locator('.rail__add').click()
  await expect(page.locator('.stage-empty__cta')).toBeVisible()
  await expect(page.locator('[data-forge]')).toHaveCount(0)

  await page.locator('.stage-empty__cta').click()
  await expect(page.locator('[data-forge="seed"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-forge]')).toHaveCount(0)

  // 长按 400ms = 菜单；短按仍然是新建空白幕
  const add = page.locator('.rail__add')
  const box = await add.boundingBox()
  if (!box) throw new Error('rail add button has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(520)
  await page.mouse.up()
  const menu = page.getByRole('menu').first()
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('生成')

  await menu.getByRole('menuitem', { name: '生成' }).click()
  await expect(page.locator('[data-forge="seed"]')).toBeVisible()

  log.assertClean()
})
