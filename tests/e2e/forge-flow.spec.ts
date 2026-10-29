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
/**
 * v0.2.5 主链路会改 prompt 载荷（材料 / 受众 / 设计预设都会进 `outlineRequest`），
 * 严格回放按 `promptDigest` 精确匹配，必然 miss 并抛 `notConfigured`。
 * 所以这一条走 `channel=mock`——同样是零外网的离线通道，测的是流程，不是通道实现。
 */
const FLOW_URL = '/?still=1&channel=mock&speed=0'

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
async function openForge(page: Page, url: string = FORGE_URL): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle' })
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

/**
 * v0.2.5 主链路：加材料 → 改标题/要点 → 生成中纠偏 → 开演下一步。
 *
 * 断言全部落在 §4 的 `data-*` 钩子上，不比像素；通道沿用本文件的 L0/replay 组合。
 * 纠偏只在 casting 窗口里出现，所以点完「开始生成」立刻写这一句（`?still=1` 把节奏归零，窗口最短）。
 */
test('造幕台 v0.2.5：加材料 → 逐幕改标题/要点 → 生成中纠偏 → 开演下一步', async ({ page }) => {
  const log = collectErrors(page)
  await openForge(page, FLOW_URL)

  // 动作 1：加材料（粘贴入口；文件入口读的是 FileReader，同一份 makeMaterial 落料）
  await page.locator('[data-material-add]').click()
  await page.locator('[data-material-kind="paste"]').click()
  await page.locator('[data-material-field="paste"]').fill('材料一：改版的三个结论是统一入口、减少跳转、先讲结果')
  await page.locator('[data-material-confirm="paste"]').click()
  await expect(page.locator('[data-forge-materials] [data-material-id]')).toHaveCount(1)
  await expect(page.locator('[data-forge-materials] [data-material-status="ready"]')).toHaveCount(1)

  // 动作 2：受众 + 设计预设（ghost 行，不进文字预算）
  await page.locator('[data-audience="exec"]').click()
  await expect(page.locator('[data-audience="exec"]')).toHaveAttribute('aria-checked', 'true')
  const themeDots = page.locator('.forge-pref__theme')
  expect(await themeDots.count()).toBeGreaterThan(1)
  await themeDots.nth(1).click()
  await expect(themeDots.nth(1)).toHaveAttribute('aria-checked', 'true')

  await page.locator('.forge-seed__input').fill(PROMPT)
  await page.locator('[data-act="deal"]').click()
  await expect(page.locator('[data-forge="deal"]')).toBeVisible({ timeout: 30_000 })

  // 动作 3a：卡内改标题（F2 进内联编辑，Enter 提交；焦点回到这张卡）
  const card = page.locator('[data-forge-card]').nth(1)
  await card.press('F2')
  const field = page.locator('[data-deal-edit-field="1"]')
  await expect(field).toBeVisible()
  await field.fill('三分钟讲清')
  await field.press('Enter')
  await expect(page.locator('[data-forge-card]').nth(1).locator('[data-card-title]')).toContainText('三分钟讲清')

  // 动作 3b：要点（brief）：Enter 提交，失焦不还原
  const brief = page.locator('[data-brief-editor="1"] [data-brief-field="1"]')
  await expect(brief).toBeVisible()
  await brief.fill('三件事：材料、大纲、纠偏')
  await brief.press('Enter')
  await expect(brief).toHaveValue('三件事：材料、大纲、纠偏')

  // 动作 4：生成中纠偏（队列条数 + 撤销入口都在 data-* 上）
  await page.locator('[data-act="cast"]').click()
  const steer = page.locator('[data-forge-steer]')
  const steerInput = page.locator('[data-forge-steer-input]')
  await steerInput.fill('后面几幕更短')
  await steerInput.press('Enter')
  // 一次往返取完整快照：?still=1 把节奏归零，队列在下一幕落位时就会清零，逐条断言会飘。
  const queued = await steer.evaluate((node) => ({
    total: node.getAttribute('data-steer-total'),
    count: node.getAttribute('data-steer-count'),
    notes: node.querySelectorAll('[data-steer-id]').length,
    label: node.querySelector('.forge-steer__queued')?.textContent?.trim() ?? '',
    from: node.querySelector('.forge-steer__from')?.textContent?.trim() ?? '',
  }))
  expect(queued.total).toBe('1')
  expect(queued.count).toBe('1')
  expect(queued.notes).toBe(1)
  // F 类计数器（已排队 {n}）与 steer.ts 的「第 n 幕起生效」各自出现，两句都在这一行。
  expect(queued.label).toContain('1')
  expect(queued.from.length).toBeGreaterThan(0)

  // 动作 5：开演下一步（三枚钩子齐全）
  await expect(page.locator('[data-forge="premiere"]')).toBeVisible({ timeout: 60_000 })
  const next = await page
    .locator('[data-forge-next]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-forge-next')).sort())
  expect(next).toEqual(['edit', 'more', 'play'])

  // 继续编辑：关台，并把编辑器定位到刚生成的这一套
  await page.locator('[data-forge-next="edit"]').click()
  await expect(page.locator('html[data-lumen-forge="1"]')).toHaveCount(0)
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()

  log.assertClean()
})

/** v0.2.5 动作 5 的另一半：开演席「再加几幕」= 回大纲并追加 3 幕（9 → 12）。 */
test('造幕台 v0.2.5：开演席「再加几幕」回大纲追加 3 幕', async ({ page }) => {
  const log = collectErrors(page)
  await openForge(page, FLOW_URL)

  await page.locator('.forge-seed__input').fill(PROMPT)
  await page.locator('[data-act="deal"]').click()
  await expect(page.locator('[data-forge="deal"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-forge-card]')).toHaveCount(9)

  await page.locator('[data-act="cast"]').click()
  await expect(page.locator('[data-forge="premiere"]')).toBeVisible({ timeout: 60_000 })

  await page.locator('[data-forge-next="more"]').click()
  await expect(page.locator('[data-forge="deal"]')).toBeVisible()
  await expect(page.locator('[data-forge-card]')).toHaveCount(12)
  // 追加的 3 幕沿用 reducer `add` 的卡型（statement），首末锁不变。
  const recipes = await page
    .locator('[data-forge-card]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-card-recipe')))
  expect(recipes[0]).toBe('cover')
  expect(recipes[recipes.length - 1]).toBe('closing')
  expect(recipes.filter((recipe) => recipe === 'statement').length).toBeGreaterThanOrEqual(3)

  // 加完的 12 幕能重新生成并回到开演席（卡片与大纲逐项对齐，见 state.ts 的 blankOutlineSlide 兜底）
  await page.locator('[data-act="cast"]').click()
  await expect(page.locator('[data-forge="premiere"]')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-forge-screen="premiere"]')).toHaveAttribute('data-forge-count', '12')

  log.assertClean()
})

