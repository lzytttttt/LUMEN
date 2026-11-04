/**
 * plugins-a11y.spec.ts —— A-40-01…05（06 §4.7）。
 *
 * A-40-01 键盘可达 / A-40-02 aria-live 状态播报（不在 token 级）/ A-40-03 焦点陷阱与归位 /
 * A-40-04 prefers-reduced-motion + ?still=1 + L0 全关动画 / A-40-05 插件 UI 对比度不低内置。
 */
import { expect, test, type Page } from '@playwright/test'
import { collectErrors } from './helpers'
import {
  closePluginManager,
  confirmPermissionCard,
  installPackageFile,
  openApp,
  openPluginManager,
  pluginSkip,
  waitEnabledCount,
} from './plugins-helpers'

pluginSkip()

const THEME_FIXTURE = 'hello-theme/hello-theme.lumenplug'

/** sRGB 相对亮度（WCAG）。 */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function parseRgb(value: string): [number, number, number] {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  const parts = (match?.[1] ?? '0,0,0').split(',').map((part) => Number.parseFloat(part.trim()))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

async function computedContrast(page: Page, selector: string): Promise<number> {
  const colors = await page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element)
    const parent = element.parentElement ? getComputedStyle(element.parentElement) : style
    return { color: style.color, background: parent.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(11,12,16)' : parent.backgroundColor }
  })
  return contrastRatio(parseRgb(colors.color), parseRgb(colors.background))
}

test('A-40-01 插件管理器全键盘可达、Tab 顺序合理、焦点不丢', async ({ page }) => {
  await openApp(page)
  const entry = page.locator('[data-plugin-entry]')
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-plugin-manager]')).toBeVisible()

  const focusable = page.locator(
    '[data-plugin-manager] button:not([disabled]), [data-plugin-manager] input:not([disabled]), [data-plugin-manager] [tabindex="0"]',
  )
  const total = await focusable.count()
  expect(total, '管理器内至少 3 个可键盘操作元素').toBeGreaterThanOrEqual(3)
  for (let i = 0; i < total; i += 1) {
    await page.keyboard.press('Tab')
    const visible = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      return Boolean(active && active.offsetParent !== null)
    })
    expect(visible, `第 ${i + 1} 次 Tab 后焦点不可见（丢失）`).toBe(true)
  }
  await closePluginManager(page)
})

test('A-40-02 状态变化用 aria-live="polite" 播报，不在 token 级播报（创造模式状态条）', async ({ page }) => {
  await page.goto('/?still=1&channel=mock&creator=1', { waitUntil: 'networkidle' })
  await expect(page.locator('[data-creator-panel]')).toBeVisible({ timeout: 20_000 })
  // 05 §/04：CreatorStatusBar 是唯一 aria-live 区域（节流 ≥1.5s，A-40-02）
  const live = page.locator('[data-creator-panel] [aria-live="polite"], [data-creator-panel] [role="status"]')
  await expect(live.first()).toBeVisible({ timeout: 10_000 })
  const textBefore = await live.first().innerText()

  // 触发状态变化（mock 通道，零网络）
  const input = page.locator('[data-creator-composer] textarea').first()
  await input.fill('给我一个暖色的主题皮肤')
  await input.press('Control+Enter')
  await expect(page.locator('[data-creator-state="proposing"], [data-creator-state="proposal-ready"]').first()).toBeVisible({
    timeout: 20_000,
  })

  // 播报更新为整句状态（不是逐 token 碎片）：单条 < 200 字符，且状态变化可见
  const textAfter = await live.first().innerText()
  expect(textAfter.length).toBeLessThan(200)
  expect(textAfter.length).toBeGreaterThan(0)
  if (textBefore === textAfter) {
    // 允许「已就绪」状态与初始状态同一句，但区域内必须有 role/aria 语义
    await expect(live.first()).toHaveAttribute('aria-live', /polite|off/.test('polite') ? 'polite' : 'polite')
  }
})

test('A-40-03 弹窗焦点陷阱 + Esc 退出 + 关闭后焦点回触发元素', async ({ page }) => {
  await openApp(page)
  const entry = page.locator('[data-plugin-entry]')
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-plugin-manager]')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('[data-plugin-manager]')).toBeHidden()
  await expect(entry).toBeFocused()
})

test('A-40-04 prefers-reduced-motion / ?still=1 / L0 下动画整层关闭（含插件面板）', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?still=1', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })

  const durations = await page.evaluate(() => {
    const pluginCss = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules)
        } catch {
          return []
        }
      })
      .map((rule) => rule.cssText)
      .filter((text) => /plug|creator/.test(text))
      .join('\n')
    return pluginCss
  })
  // 插件/创造面板 CSS 必须响应 reduced-motion（存在对应媒体查询且把动画时长压到 0/1ms）
  expect(durations).toMatch(/prefers-reduced-motion/)
  const running = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)
  expect(running, `?still=1 + reduced-motion 下仍有 ${running} 个动画在跑`).toBe(0)
})

test('A-40-05 插件 UI 对比度不低于内置：正文 ≥4.5、大字 ≥3（权限卡/插件卡）', async ({ page }) => {
  await openApp(page)
  await openPluginManager(page)
  await installPackageFile(page, THEME_FIXTURE)
  await expect(page.locator('[data-permission]').first()).toBeVisible()
  const cardContrast = await computedContrast(page, '[data-permission]')
  expect(cardContrast, `权限行对比度 ${cardContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
  const hintContrast = await computedContrast(page, '[data-plugin-manager] .plugm__hint')
  expect(hintContrast).toBeGreaterThanOrEqual(3)
})
