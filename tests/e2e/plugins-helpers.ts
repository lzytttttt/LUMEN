/**
 * tests/e2e/plugins-helpers.ts —— 插件 e2e 共用工具（qa-docs，task-9）。
 *
 * 纪律（06 §7）：固定 seed / `?still=1` / mock 通道；断言优先 data-* 钩子（06 §3），不依赖中文文案。
 * 运行时接线守卫：`LUMEN_PLUGIN_E2E=1` 时启用本组用例；宿主壳/运行时未接线前默认 skip，
 * 避免把「未实现」伪装成 flaky（联调完成后删除守卫，让 `pnpm e2e` 默认全跑）。
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * 守卫已移除（v0.4.0 联调完成）：插件组 e2e 默认全量执行。
 * 保留同名函数只是为了让 8 个 spec 的顶部调用零改动；不再读取环境变量。
 */
export function pluginSkip(): void {
  void test
}

export const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'plugins')
export const fixturePath = (rel: string): string => join(FIXTURES, rel)

/** `?still=1` + 固定语言（避免动画/随机导致截图与断言不稳定）。 */
export const APP_QUERY = '?still=1&lang=zh&onboard=0'

export async function openApp(page: Page): Promise<void> {
  await page.goto(`/${APP_QUERY}`, { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(300)
}

/** 打开插件管理器（顶栏入口）。 */
export async function openPluginManager(page: Page): Promise<void> {
  await page.locator('[data-plugin-entry]').click()
  await expect(page.locator('[data-plugin-manager]')).toBeVisible({ timeout: 10_000 })
}

/** 关闭管理器（Esc 由宿主先处理，焦点应回入口）。 */
export async function closePluginManager(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-plugin-manager]')).toBeHidden({ timeout: 10_000 })
}

/** 文件入口安装：管理器里触发隐藏 file input（传夹具相对路径自动拼到 tests/fixtures/plugins）。 */
export async function installPackageFile(page: Page, filePath: string): Promise<void> {
  const abs = isAbsolute(filePath) ? filePath : fixturePath(filePath)
  const input = page.locator('[data-plugin-manager] input[type="file"]')
  await input.setInputFiles(abs)
  await expect(page.locator('[data-plugin-install-confirm="1"]')).toBeVisible({ timeout: 10_000 })
}

/** 权限卡确认（默认授权：非敏感全授，敏感项按需勾选）。 */
export async function confirmPermissionCard(page: Page): Promise<void> {
  await page.locator('[data-plugin-install-confirm="1"]').click()
  await expect(page.locator('[data-plugin-manager]')).toBeVisible()
  await page.waitForTimeout(400)
}

export function pluginCard(page: Page, pluginId: string) {
  // v0.4.0：插件 iframe 自身也带 data-plugin-id + data-plugin-state（帧状态镜像），
  // 若只按 id+state 全局查会先命中插槽里的 iframe（没有管理按钮）。插件卡一律限定在管理弹窗内。
  return page.locator(`[data-plugin-manager] [data-plugin-id="${pluginId}"][data-plugin-state]`)
}

export async function pluginState(page: Page, pluginId: string): Promise<string | null> {
  return pluginCard(page, pluginId).getAttribute('data-plugin-state')
}

export async function enabledPluginCount(page: Page): Promise<number> {
  const raw = await page.locator('html').getAttribute('data-lumen-plugins')
  return raw === null ? 0 : Number(raw)
}

export async function waitEnabledCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => Number(document.documentElement.dataset.lumenPlugins ?? '0') === expected,
    count,
    { timeout: 10_000 },
  )
}

/** 触发 `lumen:plugins-changed` 事件记录（事件钩子，06 §3.2）。 */
export async function recordPluginEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __pluginEvents?: unknown[] }
    w.__pluginEvents = []
    window.addEventListener('lumen:plugins-changed', (event) => {
      w.__pluginEvents!.push((event as CustomEvent).detail)
    })
  })
}

export async function pluginEvents(page: Page): Promise<Array<{ enabledIds: string[]; count: number }>> {
  return page.evaluate(() => (window as unknown as { __pluginEvents?: unknown[] }).__pluginEvents ?? []) as Promise<
    Array<{ enabledIds: string[]; count: number }>
  >
}

export async function auditCount(page: Page): Promise<number> {
  return Number((await page.locator('[data-audit-count]').first().getAttribute('data-audit-count')) ?? 0)
}

/** 通过命令面板执行插件命令（命令分组「插件」，06 §3.1）。 */
export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-plugin-command]').first()).toBeVisible({ timeout: 5_000 }).catch(() => undefined)
}

/** 零出站网络守门（D-40-01）：除本地资源外全部 abort 并计数。 */
export async function installNetworkGuard(page: Page): Promise<{ outbound: string[] }> {
  const outbound: string[] = []
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    const local = /^(http:\/\/127\.0\.0\.1:5274|data:|blob:)/.test(url)
    if (!local) {
      outbound.push(url)
      await route.abort()
      return
    }
    await route.continue()
  })
  return { outbound }
}

/** 读取夹具文本（用于 page.evaluate 里构造 File 的拖拽/URL mock）。 */
export function readFixtureText(rel: string): string {
  return readFileSync(fixturePath(rel), 'utf8')
}

/** 页面可访问性快照（a11y 断言用）。 */
export async function activeAriaLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
}
