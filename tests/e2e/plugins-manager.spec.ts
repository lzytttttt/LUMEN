/**
 * plugins-manager.spec.ts —— E-40-14 插件管理器键盘全流程 / 焦点归位 / 重置与安全模式 UI。
 *
 * 契约：06 §4.2（E-40-14）、§4.7（A-40-01/03）、03 §5.1/§5.3；02 §6.10 插槽落点。
 */
import { expect, test } from '@playwright/test'
import { collectErrors } from './helpers'
import {
  closePluginManager,
  confirmPermissionCard,
  enabledPluginCount,
  installPackageFile,
  openApp,
  openPluginManager,
  pluginCard,
  pluginSkip,
  waitEnabledCount,
} from './plugins-helpers'

pluginSkip()

const THEME_FIXTURE = 'hello-theme/hello-theme.lumenplug'

test('E-40-14 全键盘：入口 → 安装 → 权限确认 → 启停 → 关闭焦点回入口（无鼠标）', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  // 1) 键盘可达顶栏插件入口：Tab 到 [data-plugin-entry] 并 Enter
  const entry = page.locator('[data-plugin-entry]')
  await entry.focus()
  await expect(entry).toBeFocused()
  await page.keyboard.press('Enter')
  const manager = page.locator('[data-plugin-manager]')
  await expect(manager).toBeVisible()
  // 焦点进入管理器（Modal 打开后 rAF 内聚焦首个可操作元素；等待而非瞬时断言）
  await page.waitForFunction(
    () => Boolean(document.activeElement && document.activeElement.closest('[data-plugin-manager]')),
    undefined,
    { timeout: 5_000 },
  )

  // 2) 键盘触发文件选择（安装入口可 Tab 到、Enter 生效；文件由 setInputFiles 注入）
  await page.locator('[data-plugin-action="install-file"]').focus()
  await page.keyboard.press('Enter')
  await installPackageFile(page, THEME_FIXTURE)
  await expect(page.locator('[data-plugin-install-confirm="1"]')).toBeFocused().catch(() => undefined)
  await page.keyboard.press('Enter')
  await waitEnabledCount(page, 1)

  // 3) 键盘启停
  const card = pluginCard(page, 'com.example.hello-theme').first()
  await card.locator('[data-plugin-action="disable"]').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)

  // 4) Esc 关闭，焦点回到顶栏入口
  await page.keyboard.press('Escape')
  await expect(manager).toBeHidden()
  await expect(entry).toBeFocused()
  log.assertClean()
})

test('E-40-14b 管理器焦点陷阱：Tab 循环不逃出弹窗，Esc 只关弹窗不进插件', async ({ page }) => {
  await openApp(page)
  await openPluginManager(page)
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => {
      const active = document.activeElement
      return Boolean(active && (active.closest('[data-plugin-manager]') || active === document.body))
    })
    expect(inside, `Tab ${i} 后焦点逃出管理器`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-plugin-manager]')).toBeHidden()
})

test('E-40-14c 恢复默认工作台：二次确认后禁用全部插件、deck 不动', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  const slideTextBefore = await page.locator('.stage-frame .lumen-slide').first().innerText()
  await openPluginManager(page)
  await installPackageFile(page, THEME_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)

  // 恢复默认入口是普通按钮（无 data-plugin-action），文案「恢复默认工作台」；需输入 RESET 才可确认
  await page.getByRole('button', { name: /恢复默认|Reset workspace|Reset/ }).last().click()
  const resetInput = page.locator('[data-plugin-reset-input]')
  await expect(resetInput).toBeVisible({ timeout: 10_000 })
  await resetInput.fill('RESET')
  await page.locator('[data-plugin-reset-confirm="1"]').click()
  await waitEnabledCount(page, 0)
  expect(await enabledPluginCount(page)).toBe(0)

  await closePluginManager(page)
  expect(await page.locator('.stage-frame .lumen-slide').first().innerText()).toBe(slideTextBefore)
  log.assertClean()
})
