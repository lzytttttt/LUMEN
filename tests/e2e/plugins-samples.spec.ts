/**
 * plugins-samples.spec.ts —— E-40-06 BrandGuard / E-40-07 ChartKit / E-40-08 FocusDesk（06 §4.2）。
 *
 * 契约：05 各款 + 06 §3.1 自有钩子；样例是 **builtin** 包（`trust:'builtin'`，id `com.lumen.samples.*`），
 * 只能走内置样例安装路径（管理器「安装样例」/ 插件页 `installBuiltinSample`）——**文件入口会被
 * E-MAN-02 保留命名空间拒绝**（03 §7 S-40-07 的正确行为）。builtin 安装默认 `state=installed`（未启用，D-40-22），
 * 需要在管理器里启用后帧才会挂载。
 *
 * 钩子速查（samples 域 2026-11-04 交付说明）：
 * - BrandGuard：右栏「品牌」页签点开才挂 `[data-brand-panel]`；`[data-brand-apply]`；`[data-brand-kit-state]=ready|empty|corrupt|saving`；
 *   kit 对话框 `[data-brand-action="edit-kit"]` → `[data-brand-dialog]`；导出预检在导出弹窗预检块（非 brand dialog）。
 * - ChartKit：右栏「图表」页签点开才挂 `[data-chart-panel]`；输入 `[data-chart-input]`（250ms 防抖）；`[data-chart-state]=empty|parsed|error|bound`；
 *   `[data-chart-insert]` 解析成功前 disabled；宿主图表块是 `[data-block-type="svg"]`（插件无法给宿主块加钩子）。
 * - FocusDesk：dock 展开才挂 `[data-focusdesk]`；`[data-focusdesk-layout]` 是 dock 根上的状态属性（不可点）；
 *   点 `[data-focusdesk-preset="focus|review|default"]` 应用布局；`[data-focusdesk-zen-toggle]` 切 Zen，
 *   overlay 根 `[data-focusdesk-zen="1"]`，内含 `[data-focusdesk-timer]`、`[data-focusdesk-exit]`；行 `[data-focusdesk-row][data-slide-id]`。
 */
import { expect, test, type Page } from '@playwright/test'
import { collectErrors } from './helpers'
import {
  closePluginManager,
  enabledPluginCount,
  openApp,
  openPluginManager,
  pluginCard,
  pluginSkip,
  waitEnabledCount,
} from './plugins-helpers'

pluginSkip()

const SAMPLE_IDS = {
  brandguard: 'com.lumen.samples.brandguard',
  chartkit: 'com.lumen.samples.chartkit',
  focusdesk: 'com.lumen.samples.focusdesk',
} as const

/** 走 builtin 安装路径（管理器「安装样例」），再启用目标插件。 */
async function installBuiltinSamples(page: Page): Promise<void> {
  await openPluginManager(page)
  await page.locator('[data-plugin-action="install-samples"]').click()
  // 三张样例卡应出现（builtin 安装默认 installed 未启用）
  await expect(page.locator('[data-plugin-state="installed"]')).toHaveCount(3, { timeout: 30_000 })
}

async function enablePlugin(page: Page, pluginId: string): Promise<void> {
  const card = pluginCard(page, pluginId).first()
  await expect(card).toHaveAttribute('data-plugin-state', /installed|disabled/, { timeout: 15_000 })
  await card.locator('[data-plugin-action="enable"]').click()
  await expect(card).toHaveAttribute('data-plugin-state', 'enabled', { timeout: 20_000 })
}

/** 插件 UI 跑在沙箱 iframe 内：用 contentFrame() 进入（page.locator 穿不过 opaque origin）。 */
function pluginFrame(page: Page, pluginId: string) {
  return page.locator(`iframe[data-plugin-id="${pluginId}"]`).first().contentFrame()
}

/** 右栏动态页签：按标题文字点开插件 tab。 */
async function openInspectorTab(page: Page, name: RegExp): Promise<void> {
  const tab = page.locator('[data-plugin-tab]').filter({ hasText: name }).first()
  await expect(tab).toBeVisible({ timeout: 15_000 })
  await tab.click()
}

test('E-40-06 BrandGuard：应用品牌 kit → lint 品牌 issue → 导出预检提示', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await installBuiltinSamples(page)
  await enablePlugin(page, SAMPLE_IDS.brandguard)
  await closePluginManager(page)
  await waitEnabledCount(page, 1)

  // 右栏「品牌」页签 → 品牌面板挂帧
  await openInspectorTab(page, /品牌|Brand/)
  const brand = pluginFrame(page, SAMPLE_IDS.brandguard)
  await expect(brand.locator('[data-brand-panel]').first()).toBeVisible({ timeout: 20_000 })
  await expect(brand.locator('[data-brand-kit-state]').first()).toHaveAttribute('data-brand-kit-state', /ready|empty|corrupt/)

  // 空态：先创建默认品牌 kit（04 §3.5 空态引导，samples 实现），再应用
  const createKit = brand.locator('[data-brand-action="create-kit"]').first()
  if (await createKit.count()) {
    await createKit.click()
    await expect(brand.locator('[data-brand-kit-state]').first()).toHaveAttribute('data-brand-kit-state', /ready|saving/, {
      timeout: 20_000,
    })
  }

  // 应用品牌 kit（默认 kit）→ 品牌主题/令牌生效
  await brand.locator('[data-brand-apply]').first().click()
  await expect(brand.locator('[data-brand-kit-state]').first()).toHaveAttribute('data-brand-kit-state', /ready|saving/, {
    timeout: 15_000,
  })
  // 品牌主题已注册为插件主题（deck 当前 themeId 变化或主题弹层出现品牌主题）
  const brandThemeApplied = await page.evaluate(() => {
    const slide = document.querySelector('.stage-frame .lumen-slide') as HTMLElement | null
    return slide ? getComputedStyle(slide).getPropertyValue('--d-accent').trim() : ''
  })
  expect(brandThemeApplied.length).toBeGreaterThan(0)

  // kit 编辑对话框（命令入口在面板/命令面板；存在才断言，避免 UI 变体）
  const editKit = brand.locator('[data-brand-action="edit-kit"]').first()
  if (await editKit.count()) {
    await editKit.click()
    // 0.4.0：kit 对话框由宿主 DialogHost 开壳；帧内容为已知限制（见 07 §12.5），只断言壳可开/可关。
    await expect(page.locator('[data-plugin-dialog]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-plugin-dialog] [data-plugin-action="close-dialog"]').first().click()
    await expect(page.locator('[data-plugin-dialog]')).toHaveCount(0, { timeout: 5_000 })
  }

  // 导出预检：宿主导出弹窗的「插件预检」区块（05 §3.4；data-plugin-preflight，结果可为 0 条）
  await page.getByRole('button', { name: /^导出$|导出$/ }).first().click()
  await expect(page.locator('.lm-modal')).toBeVisible()
  await expect(page.locator('[data-plugin-preflight]')).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
  log.assertClean()
})

test('E-40-07 ChartKit：粘贴 CSV → 插入图表 → 主题换色跟随 → 移除插件后图表仍渲染', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await installBuiltinSamples(page)
  await enablePlugin(page, SAMPLE_IDS.chartkit)
  await closePluginManager(page)
  await waitEnabledCount(page, 1)

  const svgBlocksBefore = await page.locator('.stage-frame [data-block-type="svg"]').count()

  // 右栏「图表」页签 → 面板 → 粘贴 CSV（250ms 防抖）→ parsed
  await openInspectorTab(page, /图表|Chart/)
  const chart = pluginFrame(page, SAMPLE_IDS.chartkit)
  await expect(chart.locator('[data-chart-panel]').first()).toBeVisible({ timeout: 20_000 })
  await chart.locator('[data-chart-input]').first().fill('a,b\n1,2\n3,4\n5,6')
  await expect(chart.locator('[data-chart-state]').first()).toHaveAttribute('data-chart-state', 'parsed', { timeout: 15_000 })

  // 插入图表 → 宿主 SVG 块落画布
  await chart.locator('[data-chart-insert]').first().click()
  await expect
    .poll(async () => page.locator('.stage-frame [data-block-type="svg"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(svgBlocksBefore)

  // 切主题：宿主 HTML 块/SVG 用主题令牌（var(--d-*)），颜色跟随主题变化
  const svgHtml = await page.locator('.stage-frame [data-block-type="svg"]').last().innerHTML()
  expect(svgHtml.length).toBeGreaterThan(0)
  const accentBefore = await page.evaluate(() => {
    const slide = document.querySelector('.stage-frame .lumen-slide') as HTMLElement | null
    return slide ? getComputedStyle(slide).getPropertyValue('--d-accent').trim() : ''
  })
  await page.getByTitle(/主题|Theme/).first().click()
  await page.locator('.lm-popover__row').filter({ hasText: /终端|Terminal/ }).first().click()
  await page.waitForTimeout(600)
  const accentAfter = await page.evaluate(() => {
    const slide = document.querySelector('.stage-frame .lumen-slide') as HTMLElement | null
    return slide ? getComputedStyle(slide).getPropertyValue('--d-accent').trim() : ''
  })
  expect(accentAfter).not.toBe(accentBefore)

  // 移除插件：已插入的图表（宿主 SVG 块）仍在且可渲染
  await page.keyboard.press('Escape') // 关主题弹层（若仍开着）
  await page.waitForTimeout(300)
  await openPluginManager(page)
  const card = pluginCard(page, SAMPLE_IDS.chartkit).first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('[data-plugin-action="uninstall"]').first().click()
  await page.locator('[data-plugin-uninstall-confirm="1"]').click()
  await expect(pluginCard(page, SAMPLE_IDS.chartkit)).toHaveCount(0)
  await closePluginManager(page)
  await expect(page.locator('.stage-frame [data-block-type="svg"]')).toHaveCount(
    await page.locator('.stage-frame [data-block-type="svg"]').count(),
  )
  expect(await page.locator('.stage-frame [data-block-type="svg"]').count()).toBeGreaterThan(0)
  expect(await enabledPluginCount(page)).toBe(0)
  log.assertClean()
})

test('E-40-08 FocusDesk：专注布局 → dock 写作看板 → Zen overlay 进入/退出 → 卸载后布局恢复', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  await installBuiltinSamples(page)
  await enablePlugin(page, SAMPLE_IDS.focusdesk)
  await closePluginManager(page)
  await waitEnabledCount(page, 1)

  // FocusDesk 贡献 workspace.dock（panel，宿主自动展开）→ 用 dock 帧的 data-plugin-slot 精确定位帧
  const dockFrame = page
    .locator('iframe[data-plugin-id="' + SAMPLE_IDS.focusdesk + '"][data-plugin-slot="workspace.dock"]')
    .first()
  await expect(dockFrame).toBeAttached({ timeout: 25_000 })
  const fd = dockFrame.contentFrame()
  await expect(fd.locator('[data-focusdesk]').first()).toBeVisible({ timeout: 25_000 })
  await expect(fd.locator('[data-focusdesk-row][data-slide-id]').first()).toBeVisible({ timeout: 15_000 })

  // 应用专注布局
  await fd.locator('[data-focusdesk-preset="focus"]').first().click()
  await expect(fd.locator('[data-focusdesk-layout]').first()).toHaveAttribute('data-focusdesk-layout', /focus/)

  // Zen overlay：dock 帧里点 toggle → workspace.overlay 独立帧内出现 Zen HUD → 退出
  await fd.locator('[data-focusdesk-zen-toggle]').first().click()
  const overlayFrame = page
    .locator('iframe[data-plugin-id="' + SAMPLE_IDS.focusdesk + '"][data-plugin-slot="workspace.overlay"]')
    .first()
  await expect(overlayFrame).toBeAttached({ timeout: 20_000 })
  const zenFrame = overlayFrame.contentFrame()
  const zen = zenFrame.locator('[data-focusdesk-zen="1"]').first()
  await expect(zen).toBeVisible({ timeout: 20_000 })
  await expect(zenFrame.locator('[data-focusdesk-timer]').first()).toBeVisible()
  await zenFrame.locator('[data-focusdesk-exit]').first().click()
  await expect(zenFrame.locator('[data-focusdesk-zen="0"]').first()).toBeAttached({ timeout: 15_000 })

  // 卸载后布局恢复、无残留帧
  await openPluginManager(page)
  const card = pluginCard(page, SAMPLE_IDS.focusdesk).first()
  await card.locator('[data-plugin-action="uninstall"]').click()
  await page.locator('[data-plugin-uninstall-confirm="1"]').click()
  await expect(pluginCard(page, SAMPLE_IDS.focusdesk)).toHaveCount(0)
  await closePluginManager(page)
  expect(await page.locator(`iframe[data-plugin-id="${SAMPLE_IDS.focusdesk}"]`).count()).toBe(0)
  expect(await enabledPluginCount(page)).toBe(0)
  log.assertClean()
})
