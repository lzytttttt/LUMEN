/**
 * plugins-lifecycle.spec.ts —— E-40-10 插件崩溃隔离（连续 3 次失败 → quarantined，工作台可用）。
 *
 * 契约：02 §3.5、03 §5.4（2500ms 无 ready / E-RUN-02 / iframe onerror 计一次失败；连续 3 次隔离）。
 * 坏插件夹具：tests/fixtures/plugins/bad/crash（plugin-core 拥有，task-9 只复用）。
 *
 * console error 口径（06 §7 白名单）：崩溃夹具会**故意**在帧内 throw，浏览器会把帧错误冒泡成
 * pageerror（"Error: intentional boot crash"）。本文件不复用 `log.assertClean()` 的全零断言，
 * 而是「过滤掉 intentional crash 后必须为 0」，属于 06 §7 允许的逐条备注白名单。
 */
import { expect, test, type Page } from '@playwright/test'
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

const CRASH_FIXTURE = 'bad/crash/crash.lumenplug'
const CRASH_PLUGIN_ID = 'com.example.bad-crash'
const INTENTIONAL = /intentional (boot )?crash/i

function expectOnlyIntentionalErrors(errors: string[]): void {
  const unexpected = errors.filter((message) => !INTENTIONAL.test(message))
  expect(unexpected, unexpected.join('\n')).toHaveLength(0)
}

/** 崩溃插件的错误卡（SlotHost 渲染，[data-plugin-error-card]）。 */
function crashErrorCard(page: Page) {
  return page.locator('[data-plugin-error-card]').first()
}

async function triggerBootFailures(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(crashErrorCard(page)).toBeVisible({ timeout: 20_000 })
    const retry = crashErrorCard(page).locator('[data-plugin-action="retry"]').first()
    await expect(retry).toBeVisible({ timeout: 5_000 })
    await retry.click()
    // ready timeout 2500ms + 帧销毁/重挂，留足余量
    await page.waitForTimeout(3_000)
  }
}

test('E-40-10 启动即崩的插件：错误卡 → 连续 3 次失败 → quarantined → 工作台仍可用', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, CRASH_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  // 管理弹窗的 backdrop 会挡住 dock 里的错误卡：先关闭弹窗再操作错误卡。
  await closePluginManager(page)

  // 首次失败：错误卡出现（错误码 + 重试/停用/看日志三按钮）
  await expect(crashErrorCard(page)).toBeVisible({ timeout: 20_000 })
  await expect(crashErrorCard(page)).toHaveAttribute('data-plugin-error', /.+/)
  await expect(crashErrorCard(page).locator('[data-plugin-action="retry"]')).toBeVisible()
  await expect(crashErrorCard(page).locator('[data-plugin-action="disable"]')).toBeVisible()

  // 再连续失败 2 次（共 3 次）→ registry 隔离，宿主销毁全部帧
  await triggerBootFailures(page, 2)
  await openPluginManager(page)
  const card = pluginCard(page, CRASH_PLUGIN_ID).first()
  await expect(card).toHaveAttribute('data-plugin-state', 'quarantined', { timeout: 20_000 })
  await expect(card.locator('[data-plugin-action="uninstall"]')).toBeVisible()

  // 工作台可用：退出管理器后画布可交互、无帧
  await closePluginManager(page)
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()
  expect(await page.locator('[data-plugin-frame]').count()).toBe(0)
  expect(await enabledPluginCount(page)).toBe(0)
  expectOnlyIntentionalErrors(log.errors)
})

test('E-40-10b 隔离不是删除：刷新后 state 仍为 quarantined，记录保留', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, CRASH_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)
  await triggerBootFailures(page, 2)

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await openPluginManager(page)
  const card = pluginCard(page, CRASH_PLUGIN_ID).first()
  await expect(card).toHaveAttribute('data-plugin-state', 'quarantined', { timeout: 15_000 })
  // 隔离后不再自动建帧（即使曾 enabled）
  await closePluginManager(page)
  expect(await page.locator('[data-plugin-frame]').count()).toBe(0)
  expectOnlyIntentionalErrors(log.errors)
})

test('E-40-10c 卸载崩溃插件后无残留：卡片消失、启用数归零、无 iframe', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, CRASH_FIXTURE)
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)
  await triggerBootFailures(page, 2)
  await openPluginManager(page)

  const card = pluginCard(page, CRASH_PLUGIN_ID).first()
  await expect(card).toHaveAttribute('data-plugin-state', 'quarantined', { timeout: 20_000 })
  await card.locator('[data-plugin-action="uninstall"]').click()
  await page.locator('[data-plugin-uninstall-confirm="1"]').click()
  await expect(pluginCard(page, CRASH_PLUGIN_ID)).toHaveCount(0)
  expect(await page.locator('[data-plugin-frame]').count()).toBe(0)
  expect(await enabledPluginCount(page)).toBe(0)
  await waitEnabledCount(page, 0)
  expectOnlyIntentionalErrors(log.errors)
})
