import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { collectErrors } from './helpers'

/**
 * 造幕台 e2e · 离线回放全流程（F 组 + D-04 + G-01 的 DOM 面）。
 *
 * 参数：`?still=1&channel=replay&speed=0`
 * - `still=1` → tier 恒 L0（`detectTier` 的第一优先级），自动开演关闭，动效冻结；
 * - `channel=replay` + `speed=0` → 回放通道同步灌帧（05 §12.5），零外网请求。
 *
 * 唯一的环境偏差：回放 fixture（`src/fixtures/ai/zh-normal/`）未落地时退回 `channel=mock`——
 * 两者都是零外网的离线通道，断言完全一致；测的是五段闭环，不是通道实现。
 *
 * 严格模式（默认）按 `promptDigest` 精确匹配，因此这里必须用 fixture 里录下的那句 prompt，
 * 且输入屏的默认选项要与录制时一致（length=normal / durationMin=10 / includeSvg / include3d）。
 * `ForgeApp` 不能把画布主题透传进 `composeOutline`，否则 user JSON 多一个 `themeId`，digest 必失配。
 */

const FIXTURE_DIR = path.join(process.cwd(), 'src/fixtures/ai/zh-normal')
const HAS_REPLAY = existsSync(FIXTURE_DIR)
const CHANNEL = HAS_REPLAY ? 'replay' : 'mock'
const FORGE_URL = `/?still=1&channel=${CHANNEL}&speed=0`

/** 回放 fixture 里录下的那句 prompt（严格模式下必须一字不差）。 */
function recordedPrompt(): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'outline-1.json'), 'utf8')) as {
      request?: { user?: string }
    }
    const payload = JSON.parse(raw.request?.user ?? '{}') as { prompt?: unknown }
    return typeof payload.prompt === 'string' && payload.prompt.trim() !== ''
      ? payload.prompt
      : '为什么演示要换成 HTML'
  } catch {
    return '为什么演示要换成 HTML'
  }
}

const PROMPT = recordedPrompt()

const RECIPES = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'data',
  'process',
  'gallery',
  'closing',
]

/** 记录 `[data-forge]` 出现过的全部取值（阶段可能在两帧内跳完，只能事后核对）。 */
async function recordForgeMarks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = window as unknown as { __forgeMarks?: string[] }
    store.__forgeMarks = []
    const sample = () => {
      const node = document.querySelector('[data-forge]')
      const mark = node?.getAttribute('data-forge')
      if (mark && store.__forgeMarks && !store.__forgeMarks.includes(mark)) store.__forgeMarks.push(mark)
    }
    const start = () => {
      sample()
      new MutationObserver(sample).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-forge', 'data-forge-tier', 'data-forge-combo'],
      })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  })
}

async function marksOf(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __forgeMarks?: string[] }).__forgeMarks ?? [])
}

/** 打开画布 → 进造幕台（顶栏入口就是 02 §2.1 的四个入口之一）。 */
async function openForge(page: Page): Promise<void> {
  await page.goto(FORGE_URL, { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await page.getByTitle('生成').click()
  await expect(page.locator('html[data-lumen-forge="1"]')).toHaveCount(1)
  await expect(page.locator('[data-forge="seed"]')).toBeVisible()
}

test('造幕台：起念 → 大纲 → 生成 → 播放，L0 下零 console error', async ({ page }) => {
  const log = collectErrors(page)
  await recordForgeMarks(page)
  await openForge(page)

  const forge = page.locator('.forge')
  await expect(forge).toHaveAttribute('data-forge-tier', 'L0')
  await expect(forge).toHaveAttribute('data-forge-combo', /^[0-6]$/)
  await expect(page.locator('html[data-lumen-forge="1"]')).toHaveCount(1)

  // 起念：空输入时主按钮不可点（F-03）。
  const cta = page.locator('[data-act="deal"]')
  await expect(cta).toBeDisabled()
  await page.locator('.forge-seed__input').fill(PROMPT)
  await expect(page.locator('.forge-seed__input')).toHaveValue(PROMPT)
  await expect(cta).toBeEnabled()

  // 起念 → 大纲
  await cta.click()
  await expect(page.locator('[data-forge="deal"]')).toBeVisible({ timeout: 30_000 })

  const cards = page.locator('[data-forge-card]')
  await expect(cards).toHaveCount(9)
  const recipes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-card-recipe')))
  expect(recipes).toHaveLength(9)
  for (const recipe of recipes) expect(RECIPES).toContain(recipe)
  expect(recipes[0]).toBe('cover')
  expect(recipes[recipes.length - 1]).toBe('closing')

  // 大纲 → 生成（cast / assemble / gate 三段的对外标记）
  await page.locator('[data-act="cast"]').click()
  await expect
    .poll(async () => (await marksOf(page)).join(','), { timeout: 30_000 })
    .toMatch(/(cast|assemble|gate)/)

  // 生成 → 开演（?still=1 关闭自动播放，必须手动点）
  await expect(page.locator('[data-forge="premiere"]')).toBeVisible({ timeout: 60_000 })
  await expect(forge).toHaveAttribute('data-forge-combo', /^[1-6]$/)

  const marks = await marksOf(page)
  expect(marks[0]).toBe('seed')
  expect(marks).toContain('deal')
  expect(marks).toContain('premiere')
  expect(marks.some((mark) => ['cast', 'assemble', 'gate'].includes(mark))).toBe(true)

  // 开演：premiere 屏内只有一枚「播放」（dock 不重复渲染）。
  await page.locator('[data-act="premiere"]').click()
  await expect(page.locator('.play-root')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.play-root')).toContainText(/1\s*\/\s*\d+/)

  log.assertClean()
})

test('造幕台：L0 起念屏 ≤6 组文字块，示例卡只填入不提交，Esc 退出不留台面', async ({ page }) => {
  const log = collectErrors(page)
  await openForge(page)

  const blocks = page.locator('[data-forge="seed"] [data-forge-text]')
  await expect(blocks.first()).toBeVisible()
  expect(await blocks.count()).toBeLessThanOrEqual(6)

  const sample = page.locator('.forge-seed__sample').first()
  const sampleText = (await sample.innerText()).trim()
  await sample.click()
  await expect(page.locator('.forge-seed__input')).toHaveValue(sampleText)
  // 只填入、不提交：仍停在 seed 屏。
  await expect(page.locator('[data-forge="seed"]')).toBeVisible()
  await expect(page.locator('[data-forge="deal"]')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.locator('html[data-lumen-forge="1"]')).toHaveCount(0)
  await expect(page.locator('[data-forge]')).toHaveCount(0)
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()

  log.assertClean()
})
