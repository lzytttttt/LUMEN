import { expect, test } from '@playwright/test'
import { collectErrors } from './helpers'

/** 门户页（独立入口）→ 工作台 → 首启三步。 */
test('门户：品牌与入口 → 进入工作台 → 首启三步出现', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/portal.html', { waitUntil: 'networkidle' })

  await expect(page.locator('.portal')).toBeVisible()
  await expect(page.locator('.portal__claim')).toContainText('从一句话')
  await expect(page.getByRole('button', { name: /进入工作台|Open forge/ })).toBeVisible()

  // 中英切换：同一页的文案与排版都跟着走。
  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.locator('.portal__claim')).toContainText('From a single line')
  await page.getByRole('button', { name: '中', exact: true }).click()
  await expect(page.locator('.portal__claim')).toContainText('从一句话')

  // 实机窗口：切到「全屏开演」，图片与标题一起换。
  await page.getByRole('tab', { name: /全屏开演|Playback/ }).click()
  await expect(page.locator('.shot__view img')).toHaveAttribute('src', /ui-play/)
  await expect(page.locator('.author__body h3')).toHaveText('无极Ayaya')
  await expect(page.locator('.author__links')).toContainText('Apache-2.0 + Commons Clause')
  await expect(page.locator('.author__links')).toContainText('lzytttttt@gmail.com')

  // 设置抽屉：打开 / 关闭，零 console error。
  await page.getByRole('button', { name: '偏好设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /设置|Settings/ })).toBeVisible()
  await page.getByRole('button', { name: /关闭|Close/ }).click()

  await page.getByRole('button', { name: /进入工作台|Open forge/ }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('[data-onboard="1"]')).toBeVisible()
  await expect(page.locator('.topbar')).toBeVisible()

  // 首启三步的「开始」会预填一句示例，省掉第一步打字。
  await page.getByRole('button', { name: /开始|Start/ }).click()
  await expect(page.locator('[data-forge="seed"]')).toBeVisible()
  await expect(page.locator('.forge-seed__input')).toHaveValue('为什么演示要换成 HTML')

  log.assertClean()
})
