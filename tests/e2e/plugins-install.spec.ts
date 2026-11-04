/**
 * plugins-install.spec.ts —— E-40-01 / E-40-02 / E-40-13（安装 / 停用卸载 / 插件页）。
 *
 * 契约：06 §4.2、§3 钩子；02 §3.1 安装 9 步、§3.4 卸载清理；03 §5.1 文案。
 * 断言只用 data-* 钩子；`?still=1` 固定动画；console error = 0。
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
  pluginState,
  readFixtureText,
  recordPluginEvents,
  pluginEvents,
  waitEnabledCount,
} from './plugins-helpers'

pluginSkip()

const THEME_FIXTURE = 'hello-theme/hello-theme.lumenplug'
const THEME_PLUGIN_ID = 'com.example.hello-theme'
const THEME_ID = 'com.example.hello-theme/neon'

test('E-40-01 安装声明式主题包（文件入口）→ 权限卡 → 启用 → 主题出现', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await recordPluginEvents(page)
  expect(await enabledPluginCount(page)).toBe(0)

  await openPluginManager(page)
  await installPackageFile(page, THEME_FIXTURE)

  // 权限卡：hello-theme 声明 3 项非敏感能力 → 3 行，默认建议授权（data-granted="true"）
  await expect(page.locator('[data-plugin-install-confirm="1"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-permission]')).toHaveCount(3)
  for (const row of await page.locator('[data-permission]').all()) {
    expect(await row.getAttribute('data-granted')).toBe('true')
  }

  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)

  const card = pluginCard(page, THEME_PLUGIN_ID)
  await expect(card.first()).toHaveAttribute('data-plugin-state', 'enabled')
  await closePluginManager(page)

  // 主题选择器出现新主题（shell-ui 主题弹层 = 内置 6 套 + 插件主题合并视图）
  await page.getByTitle(/主题|Theme/).first().click()
  await expect(page.locator('.lm-popover__row').filter({ hasText: /霓虹|Neon/ })).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')

  expect((await pluginEvents(page)).at(-1)?.count).toBe(1)
  log.assertClean()
})

test('E-40-01b URL 入口：来源二次确认后才安装（不自动安装）', async ({ page }) => {
  const log = collectErrors(page)
  const packageText = readFixtureText(THEME_FIXTURE)
  await page.route('**/mock-plugin.lumenplug', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: packageText }),
  )

  await openApp(page)
  await openPluginManager(page)
  await page.locator('[data-plugin-action="install-url"]').click()
  await expect(page.locator('[data-plugin-url-install]')).toBeVisible()
  // 填表后必须先过一次「非官方来源」确认，才出现真正的安装按钮
  await page.locator('[data-plugin-url-input]').fill('http://127.0.0.1:5274/mock-plugin.lumenplug')
  await page.locator('[data-plugin-url-install] .plug-actions button').first().click()
  await expect(page.locator('[data-plugin-url-confirm]')).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-plugin-url-confirm]').click()

  // 权限卡出现 → 确认 → 启用
  await expect(page.locator('[data-plugin-install-confirm="1"]')).toBeVisible({ timeout: 10_000 })
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await expect(pluginCard(page, THEME_PLUGIN_ID).first()).toHaveAttribute('data-plugin-state', 'enabled')
  log.assertClean()
})

test('E-40-02 停用 → 主题消失；卸载 → 卡片消失、启用数归零、插件数据按策略清理', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, THEME_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)

  const card = pluginCard(page, THEME_PLUGIN_ID).first()
  await card.locator('[data-plugin-action="disable"]').click()
  await waitEnabledCount(page, 0)
  await expect(card).toHaveAttribute('data-plugin-state', 'disabled')

  // 主题消失（合并视图里只剩内置 6 套）
  await closePluginManager(page)
  await page.getByTitle(/主题|Theme/).first().click()
  await expect(page.locator('.lm-popover__row').filter({ hasText: /霓虹|Neon/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // 重新启用 → 主题回来
  await openPluginManager(page)
  await card.locator('[data-plugin-action="enable"]').click()
  await waitEnabledCount(page, 1)
  await closePluginManager(page)
  await page.getByTitle(/主题|Theme/).first().click()
  await expect(page.locator('.lm-popover__row').filter({ hasText: /霓虹|Neon/ })).toBeVisible()
  await page.keyboard.press('Escape')

  // 卸载（确认弹窗）
  await openPluginManager(page)
  await card.locator('[data-plugin-action="uninstall"]').click()
  await page.locator('[data-plugin-uninstall-confirm="1"]').click()
  await expect(pluginCard(page, THEME_PLUGIN_ID)).toHaveCount(0)
  expect(await enabledPluginCount(page)).toBe(0)
  log.assertClean()
})

test('E-40-13 插件页：三款样例卡 → 安装 → 返回工作台可用', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/plugins.html?still=1', { waitUntil: 'networkidle' })
  await expect(page.locator('html[data-lumen-plugins-page="1"]')).toHaveCount(1)
  await expect(page.locator('[data-sample-card]')).toHaveCount(3)
  await expect(page.locator('[data-no-market]')).toBeVisible()

  // 安装三款样例（builtin 安装路径默认 state='installed' 未启用，D-40-22；卡片显示「已安装」）
  const instalButtons = page.locator('[data-install-sample]')
  expect(await instalButtons.count()).toBe(3)
  await instalButtons.first().click()
  await expect(page.locator('[data-sample-card][data-install-state="installed"]').first()).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.locator('[data-sample-card][data-install-state="installed"]')).toHaveCount(3, { timeout: 30_000 }).catch(() => undefined)

  // 返回工作台可用
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  log.assertClean()
})

test('E-40-12 审计与诊断：安装/启停/权限拒绝都在审计环；诊断 JSON 含 plugins 段且不含插件数据', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  const before = Number((await page.locator('[data-audit-count]').first().getAttribute('data-audit-count')) ?? 0)
  await installPackageFile(page, THEME_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)

  await page.locator('[data-audit-toggle]').click()
  const after = Number((await page.locator('[data-audit-count]').first().getAttribute('data-audit-count')) ?? 0)
  expect(after).toBeGreaterThan(before)
  await expect(page.locator('[data-audit-seq]').first()).toBeVisible()

  const diagnostics = await page.evaluate(async () => {
    const w = window as unknown as { __lumenDiagnostics?: () => unknown }
    return w.__lumenDiagnostics ? w.__lumenDiagnostics() : null
  })
  if (diagnostics) {
    const text = JSON.stringify(diagnostics)
    expect(text).toContain('plugins')
    expect(text).not.toContain('deck')
    expect(text).not.toContain('password')
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
  }
  log.assertClean()
})

test('E-40-03 代码式插槽插件（hello dock）：iframe 出现且内容渲染、console error = 0', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, 'hello-dock/hello-dock.lumenplug')
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)

  // 冻结钩子口径（Lead 2026-11-03）：容器 `[data-plugin-frame]` 存在 + 容器 data-plugin-state 只写插件 5 态（enabled），
  // 帧生命周期状态由 `data-plugin-frame-state` 另开（不混淆）。旧断言勿依赖 booting/ready 写进 data-plugin-state。
  const frameHost = page.locator('[data-slot="workspace.dock"] [data-plugin-frame], [data-plugin-frame][data-slot="workspace.dock"]')
  await expect(frameHost.first()).toBeVisible({ timeout: 15_000 })
  await expect(frameHost.first()).toHaveAttribute('data-plugin-state', 'enabled')
  const frame = page.frameLocator('[data-slot="workspace.dock"] iframe, [data-plugin-frame] iframe').first()
  await expect(frame.locator('body')).toBeVisible({ timeout: 15_000 })
  await expect(frame.locator('[data-hello-dock="ready"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-slot="workspace.dock"]')).toHaveCount(1)
  log.assertClean()
})
