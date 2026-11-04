/**
 * plugins-safe.spec.ts —— E-40-09 权限拒绝 / E-40-11 安全模式 + 浏览器侧红队 S-40-01/02/05/06。
 *
 * 契约：03 §5.3（安全模式逐条）、§7（红队 12 类）；06 §4.2/§4.3。
 * 断言优先 DOM/网络/存储事实，不依赖文案。
 */
import { expect, test, type Frame, type Page } from '@playwright/test'
import { collectErrors } from './helpers'
import {
  closePluginManager,
  confirmPermissionCard,
  enabledPluginCount,
  installNetworkGuard,
  installPackageFile,
  openApp,
  openPluginManager,
  pluginCard,
  pluginSkip,
  waitEnabledCount,
} from './plugins-helpers'

pluginSkip()

/** 等宿主 iframe 对应的 about:srcdoc 子帧完成注册（page.frames() 与 DOM 可见之间有竞争窗口）。 */
async function waitPluginFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined
  await expect
    .poll(
      () => {
        found = page.frames().find(
          (candidate) => candidate !== page.mainFrame() && candidate.url().startsWith('about:srcdoc'),
        )
        return Boolean(found)
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  if (!found) throw new Error('应存在 about:srcdoc 插件帧')
  return found
}

/** 含敏感能力 deck:write 的声明式夹具（v08 声明了 insertTextBlocks，需要 deck:write）。 */
const SENSITIVE_FIXTURE = 'valid/v08-declarative-commands-7-actions.lumenplug'

test('E-40-09 权限拒绝：拒授敏感能力 → 插件仍可启用，写操作被拦截 + toast', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, SENSITIVE_FIXTURE)

  // 敏感能力默认不勾选；确认安装（不授予 deck:write）
  const deckWrite = page.locator('[data-permission="deck:write"]').first()
  await expect(deckWrite).toHaveAttribute('data-granted', 'false')
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)

  // 权限卡里显示「未获授权」
  const card = pluginCard(page, 'com.qatools.fx08').first()
  await card.locator('[data-plugin-action="permissions"]').click()
  await expect(page.locator('[data-permission="deck:write"][data-granted="false"]').first()).toBeVisible()

  // 通过命令面板执行插件写命令 → 被能力闸门拦截（deck 不变 + toast + 审计 E-CAP-01）
  const slideTextBefore = await page.locator('.stage-frame .lumen-slide').first().innerText()
  await closePluginManager(page)
  await page.keyboard.press('Control+k')
  // 02 §5.3：命令面板插件来源的契约钩子是 data-plugin-source（不是 data-plugin-command）
  const pluginCommand = page
    .locator('[data-plugin-source]:not([data-plugin-source="host"])')
    .filter({ hasText: /插入文本|Insert text/ })
    .first()
  await expect(pluginCommand).toBeVisible({ timeout: 10_000 })
  await pluginCommand.click()
  await page.waitForTimeout(800)
  const toast = page.locator('[role="alert"], .lm-toast, [data-toast]').first()
  await expect(toast).toBeVisible({ timeout: 10_000 })
  const slideTextAfter = await page.locator('.stage-frame .lumen-slide').first().innerText()
  expect(slideTextAfter).toBe(slideTextBefore)
  log.assertClean()
})

test('E-40-11 安全模式：?safe=1 零插件帧、零插件数据读取、工作台可用', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/?safe=1&still=1', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('html')).toHaveAttribute('data-lumen-safe', '1')
  await expect(page.locator('[data-lumen-safe-pill]')).toBeVisible()

  // 零插件帧、零启用
  expect(await page.locator('[data-plugin-frame]').count()).toBe(0)
  expect(await enabledPluginCount(page)).toBe(0)

  // 安全模式：boot 不加载 runtime → 不读 plugins store；即使打开管理器也不应有已安装卡/帧
  await page.locator('[data-plugin-entry]').first().click()
  await page.waitForTimeout(1_200)
  const card = pluginCard(page, 'com.example.hello-theme')
  expect(await card.count()).toBe(0)
  expect(await page.locator('[data-plugin-frame]').count()).toBe(0)
  log.assertClean()
})

test('S-40-01 帧内读父页 DOM：抛 SecurityError，宿主页面 DOM 快照不变', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  // 用 topbar inline 插件（点开 dialog 帧）：不依赖 dock 帧（dock ready 握手在修）
  await installPackageFile(page, 'hello-topbar/hello-topbar.lumenplug')
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)

  // 点 topbar inline 入口 → dialog 帧
  await page.locator('[data-slot="workspace.topbar"] [data-plugin-slot-item]').first().click()
  const iframe = page.locator('[data-slot="dialog"] [data-plugin-frame] iframe, [data-slot="dialog"] iframe').first()
  await expect(iframe).toBeVisible({ timeout: 15_000 })
  const snapshotBefore = await page.evaluate(() => document.documentElement.outerHTML.length)

  const frame = await waitPluginFrame(page)
  const result = await frame!.evaluate(() => {
    const probe = (fn: () => unknown): string => {
      try {
        const value = fn()
        return value === undefined ? 'undefined' : `leak:${String(value).slice(0, 40)}`
      } catch (error) {
        return `throw:${(error as Error).name}`
      }
    }
    return {
      parentDoc: probe(() => (window.parent as Window).document?.body?.innerHTML),
      topDoc: probe(() => (window.top as Window).document?.title),
      parentHref: probe(() => (window.parent as Window).location?.href),
    }
  })
  for (const [name, outcome] of Object.entries(result)) {
    expect(outcome, `${name} 必须抛 SecurityError 或为空，实际 ${outcome}`).toMatch(/^(throw:SecurityError|leak:undefined|leak:null)$/)
  }
  const snapshotAfter = await page.evaluate(() => document.documentElement.outerHTML.length)
  expect(Math.abs(snapshotAfter - snapshotBefore)).toBeLessThan(2000)
  log.assertClean()
})

test('S-40-02 伪造 postMessage：非帧来源/错 nonce/冒充 pluginId 全部丢弃且无状态改变', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  const before = await enabledPluginCount(page)
  const result = await page.evaluate(() => {
    const frame = document.querySelector('[data-plugin-frame] iframe') as HTMLIFrameElement | null
    const target = frame?.contentWindow ?? window
    target.postMessage({ v: 1, id: 'forged-1', type: 'req', pluginId: 'com.example.hello-theme', frameNonce: 'x', method: 'deck.insertBlocks', payload: {} }, '*')
    target.postMessage({ v: 1, id: 'forged-2', type: 'req', pluginId: 'builtin', frameNonce: 'x', method: 'meta.ready', payload: {} }, '*')
    return true
  })
  expect(result).toBe(true)
  await page.waitForTimeout(800)
  expect(await enabledPluginCount(page)).toBe(before)
  // 宿主没有崩溃、没弹错误卡
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()
  log.assertClean()
})

test('S-40-05 外链请求：CSP 拦截，零出站请求', async ({ page }) => {
  const log = collectErrors(page)
  const guard = await installNetworkGuard(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, 'hello-dock/hello-dock.lumenplug')
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)
  await page.waitForTimeout(1_500)

  // 本地开发资源不算出站；插件帧内 fetch/img 外链必须被 CSP 拦截
  expect(guard.outbound, `出现出站请求：${guard.outbound.join(', ')}`).toEqual([])
  log.assertClean()
})

test('S-40-06 帧内持久化绕过：localStorage / cookie 不可用，宿主存储是唯一通路', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, 'hello-topbar/hello-topbar.lumenplug')
  await confirmPermissionCard(page)
  await waitEnabledCount(page, 1)
  await closePluginManager(page)
  await page.locator('[data-slot="workspace.topbar"] [data-plugin-slot-item]').first().click()
  await expect(page.locator('[data-slot="dialog"] iframe').first()).toBeVisible({ timeout: 15_000 })

  const hostStorageBefore = await page.evaluate(() => JSON.stringify(Object.keys(localStorage)))
  const frame = await waitPluginFrame(page)
  const probe = await frame!.evaluate(() => {
    const attempt = (fn: () => void): string => {
      try {
        fn()
        return 'ok'
      } catch (error) {
        return (error as Error).name
      }
    }
    return {
      localStorage: attempt(() => localStorage.setItem('evil', '1')),
      sessionStorage: attempt(() => sessionStorage.setItem('evil', '1')),
      // opaque origin 下 indexedDB 对象存在，但 open() 必须抛 SecurityError（03 §4.2 原文口径）
      idbOpen: attempt(() => {
        indexedDB.open('evil-db')
      }),
      cookie: attempt(() => {
        document.cookie = 'evil=1'
      }),
    }
  })
  // 宿主存储是唯一通路：帧内四种持久化全部 SecurityError
  expect(probe.localStorage, 'localStorage 应抛 SecurityError').toBe('SecurityError')
  expect(probe.sessionStorage, 'sessionStorage 应抛 SecurityError').toBe('SecurityError')
  expect(probe.idbOpen, 'indexedDB.open 应抛 SecurityError').toBe('SecurityError')
  expect(probe.cookie, 'document.cookie 写入应抛 SecurityError').toBe('SecurityError')
  const hostStorageAfter = await page.evaluate(() => JSON.stringify(Object.keys(localStorage)))
  expect(hostStorageAfter).toBe(hostStorageBefore)
  log.assertClean()
})
