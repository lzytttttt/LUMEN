/**
 * plugins/declarative/theme.ts —— 主题贡献 → 合法 `Theme`（02 §6.2）。
 *
 * 规则：
 * - 最终 id = `${pluginId}/${slug}`；不得覆盖 6 套内置 id（manifest 期已拦，这里再挡一次）；
 * - `font` 缺省补 `THEMES.noir` 的字体栈；`accent` 缺省回落 `fg`；
 * - 对比度兜底：`fg/bg ≥ 7:1`、`muted/bg ≥ 4.5:1`、`accent/bg ≥ 3:1`，不达标自动提亮/压暗到最近达标值，
 *   并把修正写进 warnings（由 registry 在 `plugin.enable` 审计 detail 里留档），**不因对比度拒绝安装**；
 * - 只读不写 `THEMES` 常量：插件主题存在本模块的副本里，通过 `resolvePluginTheme` 暴露给宿主。
 */
import type { Theme } from '@/schema/deck'
import { THEMES } from '@/themes'
import { darkenColor, lightenColor } from '@/themes'
import { contrastRatio, parseColor } from '@/lint/color'
import { BUILTIN_THEME_IDS } from '../manifest'
import type { RegisteredTheme, ThemeContribution } from '../types'

const pluginThemes = new Map<string, RegisteredTheme>()

function fontOf(contribution: ThemeContribution): Theme['font'] {
  const base = THEMES.noir.font
  return {
    body: contribution.font?.body ?? base.body,
    display: contribution.font?.display ?? base.display,
    mono: contribution.font?.mono ?? base.mono,
  }
}

/** 对比度兜底：往「远离 bg」的方向微调，最多 24 步（0.02/步）。 */
function fixContrast(color: string, background: string, target: number): { color: string; fixed: boolean } {
  if (contrastRatio(color, background) === null || parseColor(color) === null) {
    return { color, fixed: false }
  }
  const backgroundIsDark = (parseColor(background)?.r ?? 0) + (parseColor(background)?.g ?? 0) + (parseColor(background)?.b ?? 0) < 384
  let current = color
  for (let step = 0; step < 24; step += 1) {
    const ratio = contrastRatio(current, background) ?? 0
    if (ratio >= target) return { color: current, fixed: step > 0 }
    current = backgroundIsDark ? lightenColor(current, 0.04) : darkenColor(current, 0.04)
  }
  return { color: current, fixed: true }
}

export interface MappedTheme {
  theme: Theme
  warnings: string[]
}

/** 把一条清单主题贡献映射成合法 `Theme`（含字体兜底与对比度修正）。 */
export function themeContributionToTheme(pluginId: string, contribution: ThemeContribution): MappedTheme {
  const warnings: string[] = []
  const finalId = `${pluginId}/${contribution.id}`
  const colors = { ...contribution.colors }
  if (!colors.accent) colors.accent = colors.fg

  const fg = fixContrast(colors.fg, colors.bg, 7)
  if (fg.fixed) {
    colors.fg = fg.color
    warnings.push(`theme:${contribution.id}:fg-contrast-fixed`)
  }
  const muted = fixContrast(colors.muted, colors.bg, 4.5)
  if (muted.fixed) {
    colors.muted = muted.color
    warnings.push(`theme:${contribution.id}:muted-contrast-fixed`)
  }
  const accent = fixContrast(colors.accent, colors.bg, 3)
  if (accent.fixed) {
    colors.accent = accent.color
    warnings.push(`theme:${contribution.id}:accent-contrast-fixed`)
  }

  const theme: Theme = {
    id: finalId,
    name: contribution.name,
    vibe: contribution.vibe,
    colors,
    font: fontOf(contribution),
    typeScale: contribution.typeScale ?? 1,
    radius: contribution.radius ?? 8,
    motion: contribution.motion ?? { ease: 'cubic-bezier(.32,.72,0,1)', ms: 420 },
    ...(contribution.texture ? { texture: contribution.texture } : {}),
    ...(contribution.glow !== undefined ? { glow: contribution.glow } : {}),
    ...(contribution.elevation ? { elevation: contribution.elevation } : {}),
  } as Theme
  return { theme, warnings }
}

/** 注册一个插件的全部主题贡献；返回 warnings（对比度修正等）。 */
export function registerPluginThemes(pluginId: string, contributions: readonly ThemeContribution[]): string[] {
  const warnings: string[] = []
  for (const contribution of contributions) {
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(contribution.id)) {
      throw new Error(`theme id "${contribution.id}" is reserved`)
    }
    const mapped = themeContributionToTheme(pluginId, contribution)
    pluginThemes.set(mapped.theme.id, { pluginId, theme: mapped.theme })
    warnings.push(...mapped.warnings)
  }
  return warnings
}

export function unregisterPluginThemes(pluginId: string): void {
  for (const [id, registered] of [...pluginThemes.entries()]) {
    if (registered.pluginId === pluginId) pluginThemes.delete(id)
  }
}

export function getPluginThemes(): RegisteredTheme[] {
  return [...pluginThemes.values()]
}

/** 单主题解析（宿主 `lumen.theme.get` / `deck.applyTheme` 校验用）。 */
export function resolvePluginTheme(themeId: string | undefined | null): Theme | undefined {
  if (!themeId) return undefined
  return pluginThemes.get(themeId)?.theme
}

/** 内置 6 套 + 插件主题（TopBar 主题弹层的合并视图；不修改 `THEMES` 常量）。 */
export function getMergedThemes(): Theme[] {
  return [...Object.values(THEMES), ...getPluginThemes().map((entry) => entry.theme)]
}

/** 仅测试用。 */
export function resetPluginThemesForTests(): void {
  pluginThemes.clear()
}
