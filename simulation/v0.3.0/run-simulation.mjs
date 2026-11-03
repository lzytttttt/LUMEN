/**
 * run-simulation.mjs —— LUMEN v0.3.0 · 模拟 LLM 全链路实战
 *
 * 做什么：
 *   1) 拉起 `mock-llm-server.mjs`（OpenAI 兼容、SSE 流式、确定性内容、请求日志）；
 *   2) 用 Playwright 驱动真实浏览器，先把设置里的通道切到模拟端点（strict JSON + 流式）；
 *   3) 依次跑：造幕台五段（大纲 → 九幕成稿含 SVG/3D → 过检 → 开演 → 播放）、
 *      AI 编排（精密模式：大纲 + 逐幕）、自然语言微调（LLM 改写 + 规则改写 + 加图/加 3D）、
 *      SVG 工作室、3D 工作室、以及三条鲁棒性场景（截断 JSON 修复 / 429 退避重试 / 断流回退）；
 *   4) 所有截图、请求日志、断言、console error、报告写进 results/。
 *
 * 用法：
 *   node simulation/v0.3.0/run-simulation.mjs
 *   node simulation/v0.3.0/run-simulation.mjs --base http://127.0.0.1:5273 --port 5299 --headed
 *
 * 前置：node_modules 已安装；5273 上已有 dev server 时直接复用，否则自动在 5275 起一个。
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUT = path.join(HERE, 'results')
const SHOTS = path.join(OUT, 'screenshots')
const LLM_DIR = path.join(OUT, 'llm')
const BROWSER_DIR = path.join(OUT, 'browser')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const CFG = {
  base: argOf('base', process.env.LUMEN_BASE ?? 'http://127.0.0.1:5273').replace(/\/+$/, ''),
  port: Number(argOf('port', '5299')),
  model: argOf('model', 'lumen-sim-0.3'),
  headed: argv.includes('--headed'),
  out: OUT,
}

const RUN_LOG = path.join(OUT, 'run.log')
const report = {
  version: 'v0.3.0',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  base: CFG.base,
  llm: { endpoint: `http://127.0.0.1:${CFG.port}/v1`, model: CFG.model },
  env: { node: process.version, platform: process.platform },
  steps: [],
  assertions: [],
  llmTasks: {},
  screenshots: [],
  errors: { console: [], page: [], failedRequests: [] },
  scenario: {},
}

/* --------------------------------- 日志 --------------------------------- */

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  await appendFile(RUN_LOG, `${line}\n`).catch(() => {})
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
  report.assertions.push({ ok: true, message })
}

async function step(id, title, fn) {
  const started = Date.now()
  process.stdout.write(`\n▶ ${id} ${title}\n`)
  try {
    const detail = (await fn()) ?? {}
    const entry = { id, title, ok: true, ms: Date.now() - started, detail }
    report.steps.push(entry)
    await log(`PASS ${id} ${title} (${entry.ms}ms) ${JSON.stringify(detail).slice(0, 240)}`)
  } catch (error) {
    const entry = { id, title, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) }
    report.steps.push(entry)
    await log(`FAIL ${id} ${title}: ${entry.error}`)
    await shotSafe(`fail-${id}`)
  }
}

/* ------------------------------- 进程管理 ------------------------------- */

const runLogStream = (prefix) => (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim() !== '') void log(`${prefix} ${line}`)
  }
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitUp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUp(url)) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有就绪：${url}`)
}

let serverChild = null
let devChild = null

async function startMockLlm() {
  await mkdir(LLM_DIR, { recursive: true })
  const logPath = path.join(LLM_DIR, 'requests.jsonl')
  const health = `http://127.0.0.1:${CFG.port}/health`
  if (await isUp(health)) {
    await log(`[sim-llm] 复用已在运行的模拟服务 ${health}`)
    return { reused: true, logPath }
  }
  serverChild = spawn(
    process.execPath,
    [
      path.join(HERE, 'mock-llm-server.mjs'),
      '--port',
      String(CFG.port),
      '--log',
      logPath,
      '--chunk-ms',
      '12',
      '--chunk-size',
      '20',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  serverChild.stdout.on('data', runLogStream('[sim-llm]'))
  serverChild.stderr.on('data', runLogStream('[sim-llm:err]'))
  await waitUp(health, 20_000, '模拟 LLM 服务')
  return { reused: false, logPath }
}

async function ensureDevServer() {
  if (await isUp(`${CFG.base}/`)) {
    await log(`[dev] 复用 dev server ${CFG.base}`)
    return { reused: true }
  }
  const port = '5275'
  await log(`[dev] 未发现 ${CFG.base}，在 ${port} 启动 vite`)
  devChild = spawn(
    process.execPath,
    [
      '--import',
      path.join(ROOT, 'scripts', 'watch-guard.mjs'),
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      port,
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  devChild.stdout.on('data', runLogStream('[dev]'))
  devChild.stderr.on('data', runLogStream('[dev:err]'))
  CFG.base = `http://127.0.0.1:${port}`
  report.base = CFG.base
  await waitUp(`${CFG.base}/`, 30_000, 'dev server')
  return { reused: false }
}

function stopChildren() {
  for (const child of [serverChild, devChild]) {
    if (!child) continue
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

/* ------------------------------- 浏览器 ------------------------------- */

let browser = null
let context = null
let page = null

const shotSafe = async (name) => {
  try {
    if (!page) return
    const file = path.join(SHOTS, `${name}.png`)
    await page.screenshot({ path: file })
    report.screenshots.push(path.relative(OUT, file).replace(/\\/g, '/'))
  } catch {
    /* 截图失败不掩盖原错误 */
  }
}

async function launchBrowser() {
  await mkdir(SHOTS, { recursive: true })
  await mkdir(BROWSER_DIR, { recursive: true })
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !CFG.headed,
    args: ['--enable-unsafe-swiftshader', '--font-render-hinting=none'],
  })
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  })
  page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.console.push(message.text())
  })
  page.on('pageerror', (error) => report.errors.page.push(String(error)))
  page.on('requestfailed', (request) => {
    report.errors.failedRequests.push({ url: request.url(), reason: request.failure()?.errorText ?? '' })
  })
}

const editorUrl = (extra = '') => `${CFG.base}/?still=1&onboard=0${extra}`
const gotoEditor = async () => {
  await page.goto(editorUrl(), { waitUntil: 'networkidle' })
  await page.locator('.stage-frame .lumen-slide').first().waitFor({ timeout: 30_000 })
}
const waitFor = async (locator, timeout = 30_000) => {
  await locator.first().waitFor({ state: 'visible', timeout })
}

/* --------------------------- 设置：切到模拟端点 --------------------------- */

async function configureLlm(model = CFG.model) {
  await page.locator('.topbar button[aria-label="设置"]').click()
  const modal = page.locator('.lm-modal')
  await waitFor(modal, 10_000)
  await page.getByRole('tab', { name: 'OpenAI 兼容端点' }).click()
  await page.locator('[data-llm-field="baseURL"]').fill(`http://127.0.0.1:${CFG.port}/v1`)
  await page.locator('[data-llm-field="model"]').fill(model)
  await page.locator('[data-llm-field="apiKey"]').fill('sk-sim-v030-local')
  await page.getByRole('tab', { name: '严格', exact: true }).click()
  await page.locator('[data-llm-test="1"]').click()
  await page.locator('.ldlg-status--ok').first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(650) // settingsSync 400ms 节流落盘
  await shotSafe('01-settings-connected')
  await page.getByRole('button', { name: '完成' }).click()
  await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

async function switchModelOnly(model) {
  await closeForge()
  await page.locator('.topbar button[aria-label="设置"]').click()
  const modal = page.locator('.lm-modal')
  await waitFor(modal, 10_000)
  await page.locator('[data-llm-field="model"]').fill(model)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '完成' }).click()
  await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

/* ------------------------------- 造幕台 ------------------------------- */

async function openForge() {
  await page.locator('.topbar button[title="生成"]').click()
  await waitFor(page.locator('[data-forge="seed"]'), 15_000)
}

async function closeForge() {
  if ((await page.locator('[data-forge]').count()) === 0) return
  await page.locator('[data-act="close"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-forge]').length === 0, null, { timeout: 10_000 })
}

async function forgeOutline(prompt, opts = {}) {
  await openForge()
  const screen = page.locator('[data-forge-screen="seed"]')
  assert((await screen.getAttribute('data-offline')) === '0', '生成通道应为已配置的 OpenAI 兼容端点（非离线 Mock）')
  await page.locator('.forge-seed__input').fill(prompt)
  if (opts.audience) await page.locator(`[data-audience="${opts.audience}"]`).click()
  if (opts.themeIndex !== undefined) await page.locator('.forge-pref__theme').nth(opts.themeIndex).click()
  if (opts.shot) await shotSafe(opts.shot)
  await page.locator('[data-act="deal"]').click()
  await waitFor(page.locator('[data-forge="deal"]'), 60_000)
  return page.locator('[data-forge-card]').count()
}

/* ---------------------------- 本地存储读取 ---------------------------- */

async function readDecks() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('lumen-deck')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const decks = await new Promise((resolve, reject) => {
      const tx = db.transaction('decks', 'readonly')
      const request = tx.objectStore('decks').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return decks
      .sort((a, b) => (b?.meta?.updatedAt ?? 0) - (a?.meta?.updatedAt ?? 0))
      .map((deck) => ({
        id: deck.id,
        title: deck.title,
        themeId: deck.themeId,
        slides: deck.slides?.length ?? 0,
        types: deck.slides?.flatMap((slide) => (slide.blocks ?? []).map((block) => block.type)) ?? [],
        providers: deck.slides?.flatMap((slide) =>
          (slide.blocks ?? []).map((block) => block.provenance?.provider).filter(Boolean),
        ) ?? [],
        headlines: deck.slides?.map((slide) => (slide.blocks ?? []).find((block) => block.type === 'text')?.text) ?? [],
      }))
  })
}

/* ------------------------------ 主流程 ------------------------------ */

const PROMPT = '为什么下一季度的复盘，要从 PPT 换成 HTML 演示'

async function scenarioForge() {
  await step('forge.outline', '造幕台：一句话 → 9 幕可编辑大纲', async () => {
    const count = await forgeOutline(PROMPT, { audience: 'exec', themeIndex: 2, shot: '02-forge-seed' })
    assert(count >= 3, `大纲卡数应 ≥3，实际 ${count}`)
    await shotSafe('03-forge-deal')
    return { cards: count }
  })

  await step('forge.brief', '造幕台：逐幕「这一幕想讲什么」进入生成请求', async () => {
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const field = page.locator('[data-brief-field="2"]')
    await field.fill('用三个真实数字说明：一次改版要花多少小时')
    await field.blur()
    await shotSafe('04-forge-deal-brief')
    return { brief: await field.inputValue() }
  })

  await step('forge.cast', '造幕台：九幕成稿（文案 + SVG + 3D + 过检）', async () => {
    await page.locator('[data-act="cast"]').click()
    await page.waitForTimeout(1400)
    await shotSafe('05-forge-cast-mid')
    const premiere = page.locator('.forge-premiere')
    await waitFor(premiere, 180_000)
    const count = Number(await premiere.getAttribute('data-forge-count'))
    await shotSafe('06-forge-premiere')
    assert(count === 9, `开演席应收到 9 幕，实际 ${count}`)
    return { count }
  })

  await step('forge.play', '造幕台：开演 → 全屏播放真实成稿', async () => {
    await page.locator('[data-act="premiere"]').click()
    await waitFor(page.locator('.play-root'), 20_000)
    await page.waitForTimeout(700)
    await shotSafe('07-play-slide-01')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(700)
    await shotSafe('08-play-slide-02')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(700)
    await shotSafe('09-play-slide-03')
    await page.keyboard.press('Escape')
    await page.locator('.stage-frame .lumen-slide').first().waitFor({ timeout: 20_000 })
    return {}
  })

  await step('forge.persist', '造幕台：成稿落库、AI 溯源、SVG/3D 块齐全', async () => {
    const decks = await readDecks()
    const deck = decks[0]
    assert(Boolean(deck), '本地应有一套已落库的演示')
    assert(deck.slides === 9, `落库幕数应为 9，实际 ${deck?.slides}`)
    const types = new Set(deck.types)
    assert(types.has('svg'), '九幕里应有 SVG 块')
    assert(types.has('three'), '九幕里应有 3D 块')
    assert(deck.providers.includes('openai'), `AI 块应带 openai 溯源，实际 ${deck.providers.join(',')}`)
    await page.waitForTimeout(600)
    await shotSafe('10-editor-generated')
    report.scenario.deck = deck
    return { slides: deck.slides, types: [...types], providers: [...new Set(deck.providers)] }
  })
}

/* --------------------------- AI 编排（精密模式） --------------------------- */

async function openComposer() {
  const button = page.locator('.topbar button[title="AI 编排"]')
  if ((await page.locator('.ai-refine').count()) === 0) await button.click()
  await waitFor(page.locator('.ai-refine'), 10_000)
}

async function scenarioComposer() {
  await step('composer.open', 'AI 编排：从顶栏打开精密模式，通道徽标为真端点', async () => {
    await openComposer()
    const channel = page.locator('.ai-channel')
    await waitFor(channel)
    assert((await channel.getAttribute('class'))?.includes('ai-channel--live'), '通道徽标应显示为已连接的端点')
    await shotSafe('11-ai-panel')
    return { channel: (await channel.innerText()).split('\n')[0] }
  })

  await step('composer.outline', 'AI 编排：提示词 → 可编辑大纲', async () => {
    const textarea = page.locator('.panel .ai-block textarea').first()
    await textarea.fill('把「演示载体的迁移」讲给非技术的管理层，10 分钟')
    await page.locator('.panel button', { hasText: '生成大纲' }).first().click()
    await page.locator('.ai-outline').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(400)
    await shotSafe('12-composer-outline')
    return {}
  })

  await step('composer.build', 'AI 编排：逐幕成稿写回当前演示', async () => {
    await page.locator('.panel button', { hasText: '逐幕成稿' }).first().click()
    await waitFor(page.locator('.ai-done, .ai-progress'), 120_000)
    await page.locator('.ai-done').waitFor({ timeout: 120_000 })
    await shotSafe('13-composer-done')
    await page.waitForTimeout(800) // autosave 400ms 节流，等落库再读
    const decks = await readDecks()
    report.scenario.composer = { slides: decks[0]?.slides, title: decks[0]?.title }
    return report.scenario.composer
  })
}

/* ------------------------------ 自然语言微调 ------------------------------ */

async function scenarioRefine() {
  await step('refine.llm', '自然语言微调：规则未命中 → 模型改写 + diff 预览', async () => {
    await page.locator('.rail__item').nth(1).click()
    await page.waitForTimeout(300)
    const input = page.locator('[data-refine-input]')
    await input.fill('像在董事会现场讲话那样，把这一页写得更具体、更有画面感')
    await page.locator('[data-refine-run]').click()
    await waitFor(page.locator('[data-refine-plan]'), 60_000)
    const preview = await page.locator('.ai-diff__line').innerText()
    await page.locator('[data-refine-plan]').scrollIntoViewIfNeeded().catch(() => {})
    await shotSafe('14-refine-plan')
    await page.locator('[data-refine-confirm]').click()
    await page.locator('[data-refine-plan]').waitFor({ state: 'detached', timeout: 10_000 })
    await shotSafe('15-refine-applied')
    return { preview }
  })

  await step('refine.rules', '自然语言微调：规则通道（时间轴）离线重排 + 应用', async () => {
    const input = page.locator('[data-refine-input]')
    await input.fill('把这一页改成时间轴')
    await page.locator('[data-refine-run]').click()
    await waitFor(page.locator('[data-refine-plan]'), 30_000)
    await page.locator('[data-refine-confirm]').click()
    await page.locator('[data-refine-plan]').waitFor({ state: 'detached', timeout: 10_000 })
    return {}
  })

  await step('refine.art', '自然语言微调：加配图 / 加 3D 走单点生成', async () => {
    const input = page.locator('[data-refine-input]')
    const results = []
    for (const instruction of ['给这一页加一张矢量插图', '再加一个 3d 场景']) {
      await input.fill(instruction)
      await page.locator('[data-refine-run]').click()
      await waitFor(page.locator('[data-refine-plan]'), 90_000)
      const chips = await page.locator('.ai-diff__line').innerText()
      results.push(chips)
      await page.locator('[data-refine-confirm]').click()
      await page.locator('[data-refine-plan]').waitFor({ state: 'detached', timeout: 10_000 })
      await page.waitForTimeout(400)
    }
    await shotSafe('16-refine-art')
    return { results }
  })
}

/* ------------------------------- 两个工作室 ------------------------------- */

async function insertFromMenu(label) {
  await page.locator('.tbar-insert').click()
  await page.locator('.lm-popover button', { hasText: label }).first().click()
  await page.waitForTimeout(400)
}

async function scenarioStudioSvg() {
  await step('studio.svg', 'SVG 工作室：一句话 → 可净化 SVG → 替换当前块', async () => {
    // 从 AI 编排回到检查器（属性页签只在检查器里）。
    if ((await page.locator('.ai-refine').count()) > 0) await page.locator('.topbar button[title="AI 编排"]').click()
    await page.getByRole('tab', { name: '属性' }).click()
    await insertFromMenu('空白 SVG')
    await waitFor(page.locator('[data-open-studio="svg"]'), 10_000)
    await page.locator('[data-open-studio="svg"]').click()
    const modal = page.locator('.lm-modal--lg')
    await waitFor(modal, 10_000)
    const input = modal.locator('[data-studio-ai-input]')
    await input.fill('一条被拉长的胶片，末端变成一块发光的屏幕，极简线描')
    await modal.locator('[data-studio-ai-run]').click()
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-studio-ai]')
        return bar && bar.getAttribute('data-busy') !== 'true'
      },
      null,
      { timeout: 90_000 },
    )
    const bar = modal.locator('[data-studio-ai]')
    assert((await bar.getAttribute('data-error')) !== 'true', 'SVG 生成不应报错')
    await page.waitForTimeout(600)
    await shotSafe('17-studio-svg')
    const inserted = await modal.locator('button', { hasText: /替换当前 SVG|插入画布/ }).count()
    if (inserted > 0) {
      await modal.locator('button', { hasText: /替换当前 SVG|插入画布/ }).first().click()
      await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    }
    return { source: 'generateSvgArt' }
  })
}

async function scenarioStudioThree() {
  await step('studio.three', '3D 工作室：一句话 → 受限场景描述符 → 替换当前块', async () => {
    await page.locator('.tbar-insert').click()
    await page.locator('.ins-preset').first().click()
    await page.waitForTimeout(400)
    await waitFor(page.locator('[data-open-studio="three"]'), 10_000)
    await page.locator('[data-open-studio="three"]').click()
    const modal = page.locator('.lm-modal--lg')
    await waitFor(modal, 10_000)
    await modal.locator('[data-studio-ai-input]').fill('三颗发光的球体缓慢自转，深色背景，克制的金色光')
    await modal.locator('[data-studio-ai-run]').click()
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-studio-ai]')
        return bar && bar.getAttribute('data-busy') !== 'true'
      },
      null,
      { timeout: 90_000 },
    )
    const bar = modal.locator('[data-studio-ai]')
    assert((await bar.getAttribute('data-error')) !== 'true', '3D 生成不应报错')
    await page.waitForTimeout(1400)
    await shotSafe('18-studio-three')
    const inserted = await modal.locator('button', { hasText: /替换当前场景|插入到当前幕/ }).count()
    if (inserted > 0) {
      await modal.locator('button', { hasText: /替换当前场景|插入到当前幕/ }).first().click()
      await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    }
    return { source: 'generateThreeScene' }
  })
}

/* ------------------------------ 鲁棒性场景 ------------------------------ */

async function robustnessOutline(model, shotName) {
  await switchModelOnly(model)
  await gotoEditor()
  try {
    const cards = await forgeOutline(PROMPT, { shot: undefined })
    await shotSafe(shotName)
    assert(cards >= 3, `鲁棒性场景应仍产出大纲，实际 ${cards} 张卡`)
    return { cards }
  } finally {
    await closeForge()
  }
}

async function scenarioRobustness() {
  await step('robust.badjson', '鲁棒性：截断 JSON → 修复/重试后仍出大纲', async () => {
    return robustnessOutline('lumen-sim-badjson', '19-robust-badjson')
  })
  await step('robust.429', '鲁棒性：429 → Retry-After 退避重试后成功', async () => {
    return robustnessOutline('lumen-sim-429', '20-robust-429')
  })
  await step('robust.streambreak', '鲁棒性：SSE 断流 → 同 body 非流式回退', async () => {
    return robustnessOutline('lumen-sim-streambreak', '21-robust-streambreak')
  })
  await step('robust.restore', '收尾：把模型名恢复为模拟主模型', async () => {
    await switchModelOnly(CFG.model)
    await gotoEditor()
    return {}
  })
}

/** 预期内的 console error：鲁棒性场景故意制造的 429 与断流资源错误。 */
const EXPECTED_CONSOLE = [
  /429 \(Too Many Requests\)/,
  /ERR_INCOMPLETE_CHUNKED_ENCODING/,
  /net::ERR_/,
]

/** 预期内的网络失败：SSE 断流演练会主动掐断一个 chunked 连接。 */
const EXPECTED_FAILED = [/ERR_INCOMPLETE_CHUNKED_ENCODING/, /ERR_ABORTED/, /ERR_CONNECTION_RESET/]

function splitErrors() {
  const expected = []
  const unexpected = []
  for (const text of report.errors.console) {
    if (EXPECTED_CONSOLE.some((pattern) => pattern.test(text))) expected.push(text)
    else unexpected.push(text)
  }
  report.errors.expectedConsole = [...new Set(expected)]
  report.errors.unexpectedConsole = [...new Set(unexpected)]

  const expectedFailed = []
  const unexpectedFailed = []
  for (const failure of report.errors.failedRequests) {
    if (EXPECTED_FAILED.some((pattern) => pattern.test(failure.reason))) expectedFailed.push(failure)
    else unexpectedFailed.push(failure)
  }
  report.errors.expectedFailedRequests = expectedFailed
  report.errors.unexpectedFailedRequests = unexpectedFailed
  return report.errors.unexpectedConsole
}

/* ------------------------------- 汇总 ------------------------------- */

async function summarizeLlm(logPath) {
  let lines = []
  try {
    lines = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean)
  } catch {
    return { requests: 0, tasks: {}, byModel: {} }
  }
  const requests = []
  for (const line of lines) {
    try {
      requests.push(JSON.parse(line))
    } catch {
      /* 半行 */
    }
  }
  const tasks = {}
  const byModel = {}
  for (const request of requests) {
    tasks[request.task] = (tasks[request.task] ?? 0) + 1
    byModel[request.model] = (byModel[request.model] ?? 0) + 1
  }
  report.llmTasks = tasks
  await writeFile(path.join(LLM_DIR, 'requests.pretty.json'), JSON.stringify(requests, null, 2))
  return { requests: requests.length, tasks, byModel }
}

async function writeReports(llmSummary) {
  report.finishedAt = new Date().toISOString()
  report.llmSummary = llmSummary
  report.failed = report.steps.filter((entry) => !entry.ok).length
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(path.join(BROWSER_DIR, 'console-errors.json'), JSON.stringify(report.errors.console, null, 2))
  await writeFile(
    path.join(BROWSER_DIR, 'console-errors-expected.json'),
    JSON.stringify(report.errors.expectedConsole ?? [], null, 2),
  )
  await writeFile(
    path.join(BROWSER_DIR, 'console-errors-unexpected.json'),
    JSON.stringify(report.errors.unexpectedConsole ?? [], null, 2),
  )
  await writeFile(path.join(BROWSER_DIR, 'page-errors.json'), JSON.stringify(report.errors.page, null, 2))
  await writeFile(path.join(BROWSER_DIR, 'failed-requests.json'), JSON.stringify(report.errors.failedRequests, null, 2))

  const totalMs = new Date(report.finishedAt) - new Date(report.startedAt)
  const rows = report.steps
    .map((entry) => {
      const status = entry.ok ? '✔' : '✘'
      const detail = entry.ok ? JSON.stringify(entry.detail ?? {}).slice(0, 120) : entry.error.slice(0, 160)
      return `| ${status} | ${entry.id} | ${entry.title} | ${entry.ms}ms | ${detail.replace(/\|/g, '\\|')} |`
    })
    .join('\n')
  const taskRows = Object.entries(llmSummary.tasks)
    .map(([task, count]) => `| ${task} | ${count} |`)
    .join('\n')
  const shotList = report.screenshots.map((file) => `![${file}](${file})`).join('\n\n')

  const markdown = `# LUMEN v0.3.0 · 模拟 LLM 全链路实战报告

- 运行时间：${report.startedAt} → ${report.finishedAt}（${(totalMs / 1000).toFixed(1)}s）
- 页面：${report.base}?still=1&onboard=0
- 模拟模型：${report.llm.endpoint} · \`${report.llm.model}\`
- LLM 请求：${llmSummary.requests} 次 · 任务分布 ${JSON.stringify(llmSummary.tasks)}
- 步骤：${report.steps.length} 项 · 失败 ${report.failed} 项
- console error：${report.errors.console.length}（预期内 ${report.errors.expectedConsole?.length ?? 0} / 预期外 ${report.errors.unexpectedConsole?.length ?? 0}）· page error：${report.errors.page.length} · 失败请求：${report.errors.failedRequests.length}（预期内 ${report.errors.expectedFailedRequests?.length ?? 0} / 预期外 ${report.errors.unexpectedFailedRequests?.length ?? 0}）

## 步骤

| 状态 | id | 说明 | 耗时 | 证据 |
|---|---|---|---|---|
${rows}

## 模型调用分布

| task | 次数 |
|---|---|
${taskRows}

## 截图

${shotList}
`
  await writeFile(path.join(OUT, 'report.md'), markdown)
  await writeFile(path.join(OUT, 'report.html'), htmlReport({ markdown, rows, taskRows, llmSummary, totalMs }))
  console.log(`\n${markdown.split('\n').slice(0, 14).join('\n')}`)
  console.log(`\n报告：${path.relative(ROOT, path.join(OUT, 'report.md'))}`)
}

function htmlReport({ llmSummary, totalMs }) {
  const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
  const cards = report.steps
    .map((entry) => {
      const detail = entry.ok ? JSON.stringify(entry.detail ?? {}) : entry.error
      return `<li class="${entry.ok ? 'ok' : 'bad'}"><b>${entry.ok ? 'PASS' : 'FAIL'}</b> <code>${escape(entry.id)}</code> ${escape(entry.title)} <span>${entry.ms}ms</span><pre>${escape(detail).slice(0, 400)}</pre></li>`
    })
    .join('\n')
  const shots = report.screenshots
    .map((file) => `<figure><img src="${escape(file)}" alt="${escape(file)}"><figcaption>${escape(file)}</figcaption></figure>`)
    .join('\n')
  const errors = [...report.errors.console, ...report.errors.page]
    .slice(0, 20)
    .map((error) => `<li>${escape(error)}</li>`)
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LUMEN v0.3.0 · 模拟 LLM 实战报告</title>
<style>
:root{color-scheme:dark;--bg:#0d0c0a;--panel:#171512;--line:#2b2620;--fg:#efe7d7;--muted:#9a9182;--gold:#d7b46a;--ok:#6fbf8f;--bad:#e07a6a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Segoe UI",system-ui,sans-serif;padding:48px 6vw}
h1{font-size:30px;margin:0 0 6px;letter-spacing:.04em}h2{margin-top:40px;font-size:17px;color:var(--gold);letter-spacing:.08em}
.lede{color:var(--muted);margin:0 0 28px}.stats{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0}
.stat{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:12px 18px;min-width:130px}
.stat b{display:block;font-size:22px;color:var(--gold)}.stat span{color:var(--muted);font-size:11px;letter-spacing:.12em}
ul.steps{list-style:none;padding:0;display:grid;gap:8px}ul.steps li{border:1px solid var(--line);border-left:3px solid var(--ok);background:var(--panel);border-radius:8px;padding:10px 14px}
ul.steps li.bad{border-left-color:var(--bad)}ul.steps li b{font-size:10px;letter-spacing:.14em;color:var(--ok);margin-right:10px}ul.steps li.bad b{color:var(--bad)}
ul.steps code{color:var(--gold)}ul.steps span{color:var(--muted);font-size:11px;margin-left:8px}ul.steps pre{margin:6px 0 0;color:var(--muted);font-size:11px;white-space:pre-wrap}
.gallery{columns:2;column-gap:14px}.gallery figure{margin:0 0 14px;break-inside:avoid;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.gallery img{display:block;width:100%;height:auto}.gallery figcaption{padding:6px 10px;color:var(--muted);font-size:11px}
.errors{color:var(--muted);font-size:12px}
table{border-collapse:collapse;margin:10px 0 4px;font-family:var(--ui-font-mono,"Cascadia Code",monospace);font-size:12px}
th,td{border:1px solid var(--line);padding:6px 14px;text-align:left}th{color:var(--gold);font-weight:600;letter-spacing:.08em}
</style>
<h1>LUMEN v0.3.0 · 模拟 LLM 全链路实战报告</h1>
<p class="lede">一个真实的 OpenAI 兼容端点（本地模拟）驱动了造幕台、AI 编排、微调、SVG/3D 工作室与三条鲁棒性路径。</p>
<div class="stats">
  <div class="stat"><b>${report.steps.filter((s) => s.ok).length}/${report.steps.length}</b><span>步骤通过</span></div>
  <div class="stat"><b>${llmSummary.requests}</b><span>LLM 请求</span></div>
  <div class="stat"><b>${Object.keys(llmSummary.tasks).length}</b><span>任务类型</span></div>
  <div class="stat"><b>${(totalMs / 1000).toFixed(1)}s</b><span>总耗时</span></div>
  <div class="stat"><b>${report.errors.unexpectedConsole?.length ?? 0}</b><span>预期外 console</span></div>
</div>
<h2>任务分布</h2>
<table class="errors"><tr><th>task</th><th>次数</th></tr>${Object.entries(llmSummary.tasks).map(([key, value]) => `<tr><td>${escape(key)}</td><td>${value}</td></tr>`).join('')}</table>
<h2>步骤</h2><ul class="steps">${cards}</ul>
<h2>页面错误</h2><ul class="errors">${errors || '<li>无</li>'}</ul>
<h2>证据截图</h2><div class="gallery">${shots}</div>
</html>`
}

/* --------------------------------- 入口 --------------------------------- */

async function main() {
  await mkdir(SHOTS, { recursive: true })
  await mkdir(BROWSER_DIR, { recursive: true })
  await writeFile(RUN_LOG, '')
  await log(`LUMEN v0.3.0 模拟 LLM 实战开始 · base=${CFG.base} · port=${CFG.port}`)
  const started = Date.now()

  // 清理上一次的请求日志，避免计数串场（服务端也按启动追加）。
  const llmLogPath = path.join(LLM_DIR, 'requests.jsonl')
  await writeFile(llmLogPath, '').catch(() => {})

  const llm = await startMockLlm()
  await ensureDevServer()
  await launchBrowser()

  try {
    await gotoEditor()
    await step('connect', '设置：通道切到模拟端点并测试连通性', async () => {
      await configureLlm()
      await gotoEditor()
      await openForge()
      const offline = await page.locator('[data-forge-screen="seed"]').getAttribute('data-offline')
      assert(offline === '0', '配置后起念屏应显示非离线通道')
      await closeForge()
      return { endpoint: report.llm.endpoint, model: CFG.model }
    })

    await scenarioForge()
    await scenarioComposer()
    await scenarioRefine()
    await scenarioStudioSvg()
    await scenarioStudioThree()
    await scenarioRobustness()
    await step('console.clean', '浏览器干净度：无预期外 console error / page error / 失败请求', async () => {
      const unexpected = splitErrors()
      assert(report.errors.page.length === 0, `不应有 page error，实际 ${report.errors.page.length}`)
      assert(unexpected.length === 0, `不应有预期外 console error，实际 ${unexpected.length}：${unexpected.slice(0, 2).join(' | ')}`)
      assert(
        (report.errors.unexpectedFailedRequests ?? []).length === 0,
        `不应有预期外失败请求，实际 ${report.errors.unexpectedFailedRequests?.length ?? 0}`,
      )
      return {
        console: { raw: report.errors.console.length, expected: report.errors.expectedConsole.length },
        requests: {
          raw: report.errors.failedRequests.length,
          expected: report.errors.expectedFailedRequests.length,
        },
      }
    })

    const llmSummary = await summarizeLlm(llm.logPath)
    report.llmSummary = llmSummary
    report.durationMs = Date.now() - started
    report.errors.console = [...new Set(report.errors.console)]
    report.errors.page = [...new Set(report.errors.page)]
    await writeReports(llmSummary)
  } finally {
    await browser?.close().catch(() => {})
    stopChildren()
  }

  const failed = report.steps.filter((entry) => !entry.ok)
  await log(`结束：${report.steps.length - failed.length}/${report.steps.length} 步通过，LLM 请求 ${report.llmSummary?.requests ?? '?'} 次`)
  if (failed.length > 0) {
    for (const entry of failed) console.error(`FAIL ${entry.id}: ${entry.error}`)
    process.exitCode = 1
  }
}

main().catch(async (error) => {
  console.error(error)
  await log(`RUNNER CRASH: ${error?.stack ?? error}`)
  report.crashed = String(error?.message ?? error)
  try {
    await writeReports(report.llmSummary ?? { requests: 0, tasks: {}, byModel: {} })
  } catch {
    /* 报告写失败不再掩盖崩溃 */
  }
  stopChildren()
  process.exitCode = 1
  process.exit(1)
})
