/**
 * simulation/v0.4.0/run-simulation.mjs —— 创造模式模拟全链路（T-40-35 的 v0.4.0 增量）。
 *
 * 一条命令可复现：
 *   node simulation/v0.4.0/run-simulation.mjs --base http://127.0.0.1:5273
 *
 * 演练路径（真实浏览器 / 真实 HTTP / 真实 SSE / 真实 IDB）：
 *   设置切到模拟端点 → 插件页安装内置样例 → 创造模式打开 → 一句话提案（plugin 任务）
 *   → 试跑（默认只读）→ 撤销改造（reverted）→ 再试跑 → 保留（saved，插件启用）
 *   → 刷新恢复（不自动重挂试跑）→ 报告落盘（report.html / md / json + 截图 + 请求日志）。
 *
 * 零新增依赖：Playwright 用仓库已有的 `@playwright/test`；模拟端点由
 * `mock-creator-server.mjs` 自动起停（默认 5299，避开 e2e 的 5274 与 dev 的 5273）。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUT = path.join(HERE, 'results')
const SHOTS = path.join(OUT, 'screenshots')
const LLM_DIR = path.join(OUT, 'llm')
const BROWSER_DIR = path.join(OUT, 'browser')
const RUN_LOG = path.join(OUT, 'run.log')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const CFG = {
  base: argOf('base', process.env.LUMEN_BASE ?? 'http://127.0.0.1:5273').replace(/\/+$/, ''),
  /** 私有 dev 端口：默认 base 不可用时自己起一个（不抢 qa 的 5274 / 别人的 5273）。 */
  devPort: Number(argOf('dev-port', '5276')),
  /** 预览模式：先 `vite build` 再 `vite preview`（零 HMR，避免队友改代码/写结果触发的整页重载干扰）。 */
  preview: argv.includes('--preview'),
  previewPort: Number(argOf('preview-port', '5277')),
  port: Number(argOf('port', '5299')),
  model: argOf('model', 'lumen-sim-plugin-0.4'),
  headed: argv.includes('--headed'),
}
const LLM_LOG = path.join(LLM_DIR, 'requests.jsonl')

const report = {
  version: 'v0.4.0',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  base: CFG.base,
  llm: { endpoint: `http://127.0.0.1:${CFG.port}/v1`, model: CFG.model },
  env: { node: process.version, platform: process.platform },
  steps: [],
  assertions: [],
  screenshots: [],
  mockRequests: { total: 0, tasks: {}, intents: {}, repairs: 0 },
  creator: {},
  errors: { console: [], page: [], failedRequests: [] },
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
    return detail
  } catch (error) {
    const entry = { id, title, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) }
    report.steps.push(entry)
    await log(`FAIL ${id} ${title}: ${entry.error}`)
    await shotSafe(`fail-${id}`)
    return null
  }
}

/* ------------------------------- 进程管理 ------------------------------- */

const pipeLog = (prefix) => (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== '') void log(`${prefix} ${line}`)
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

async function waitUp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUp(url)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有就绪：${url}`)
}

let serverChild = null
let devChild = null

async function startMockCreator() {
  await mkdir(LLM_DIR, { recursive: true })
  const health = `http://127.0.0.1:${CFG.port}/health`
  if (await isUp(health)) {
    await log(`[mock-creator] 复用已在运行的服务 ${health}`)
    return { reused: true }
  }
  serverChild = spawn(
    process.execPath,
    [path.join(HERE, 'mock-creator-server.mjs'), '--port', String(CFG.port), '--log', LLM_LOG],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  serverChild.stdout.on('data', pipeLog('[mock-creator]'))
  serverChild.stderr.on('data', pipeLog('[mock-creator:err]'))
  await waitUp(health, 20_000, '模拟创造端点')
  return { reused: false }
}

let previewChild = null

/** 构建到 dist（TEMP 指到仓库内 .tmpbuild，规避 Windows 系统 TEMP 下 esbuild EACCES）。 */
function runBuild() {
  return new Promise((resolve, reject) => {
    const temp = path.join(ROOT, '.tmpbuild')
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: ROOT,
      env: { ...process.env, TEMP: temp, TMP: temp },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', pipeLog('[build]'))
    child.stderr.on('data', pipeLog('[build:err]'))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build 失败（exit ${code}）`))))
  })
}

/** 预览模式：先构建再起 `vite preview`，零 HMR（队友改代码/写结果不会整页重载）。 */
async function startPreviewServer() {
  await log('[preview] 构建后起静态预览服务（避免 HMR 整页重载）')
  await runBuild()
  const port = String(CFG.previewPort)
  previewChild = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', port, '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  previewChild.stdout.on('data', pipeLog('[preview]'))
  previewChild.stderr.on('data', pipeLog('[preview:err]'))
  CFG.base = `http://127.0.0.1:${port}`
  report.base = CFG.base
  await waitUp(`${CFG.base}/`, 60_000, 'preview server')
  return { reused: false, preview: true }
}

async function ensureDevServer() {
  if (CFG.preview) return startPreviewServer()
  if (await isUp(`${CFG.base}/`)) {
    await log(`[dev] 复用 dev server ${CFG.base}`)
    return { reused: true }
  }
  const port = String(CFG.devPort)
  await log(`[dev] 未发现 ${CFG.base}，在 ${port} 启动 vite`)
  devChild = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(ROOT, 'scripts', 'watch-guard.mjs')).href,
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      port,
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  devChild.stdout.on('data', pipeLog('[dev]'))
  devChild.stderr.on('data', pipeLog('[dev:err]'))
  CFG.base = `http://127.0.0.1:${port}`
  report.base = CFG.base
  await waitUp(`${CFG.base}/`, 60_000, 'dev server')
  return { reused: false }
}

function stopChildren() {
  for (const child of [serverChild, devChild, previewChild]) {
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
    await mkdir(SHOTS, { recursive: true })
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
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    colorScheme: 'dark',
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
const waitFor = (locator, timeout = 30_000) => locator.first().waitFor({ state: 'visible', timeout })
const creatorState = () => page.locator('[data-creator-state]').first().getAttribute('data-creator-state')
const creatorAttr = (name) => page.locator('[data-creator-state]').first().getAttribute(name)

async function waitCreatorState(states, timeout = 30_000) {
  const wanted = Array.isArray(states) ? states : [states]
  await page.waitForFunction(
    (list) => {
      const current = document.querySelector('[data-creator-state]')?.getAttribute('data-creator-state')
      return current !== null && list.includes(current)
    },
    wanted,
    { timeout },
  )
}

/* --------------------------- 步骤 1：设置模拟端点 --------------------------- */

async function configureLlm() {
  await page.locator('.topbar button[aria-label="设置"]').click()
  const modal = page.locator('.lm-modal')
  await waitFor(modal, 10_000)
  await page.getByRole('tab', { name: 'OpenAI 兼容端点' }).click()
  await page.locator('[data-llm-field="baseURL"]').fill(report.llm.endpoint)
  await page.locator('[data-llm-field="model"]').fill(CFG.model)
  await page.locator('[data-llm-field="apiKey"]').fill('sk-sim-v040-local')
  await page.getByRole('tab', { name: '严格', exact: true }).click()
  await page.locator('[data-llm-test="1"]').click()
  await page.locator('.ldlg-status--ok').first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(650) // settingsSync 400ms 防抖落盘
  await shotSafe('01-settings-connected')
  await page.getByRole('button', { name: '完成' }).click()
  await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

/* --------------------------- 步骤 2：安装内置样例 --------------------------- */

async function installSamples() {
  await page.locator('[data-plugin-entry="1"]').click()
  await waitFor(page.locator('[data-plugin-manager]'), 15_000)
  await page.locator('[data-plugin-action="install-samples"]').click()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-plugin-id]').length >= 3,
    undefined,
    { timeout: 60_000 },
  )
  const cards = await page.locator('[data-plugin-id]').count()
  const states = await page
    .locator('[data-plugin-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-plugin-state')))
  await shotSafe('02-plugin-manager-installed')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[data-plugin-manager]').length === 0, undefined, {
    timeout: 10_000,
  }).catch(() => {})
  return { cards, states }
}

/* --------------------------- 步骤 3-8：创造模式 --------------------------- */

async function openCreator() {
  await page.locator('[data-creator-entry="topbar"]').click()
  await waitFor(page.locator('[data-creator-panel]'), 20_000)
  await waitCreatorState(['idle', 'proposal-ready', 'saved', 'reverted'], 20_000)
  return {
    state: await creatorState(),
    panel: await page.locator('[data-creator-panel]').count(),
    dataset: await page.evaluate(() => document.documentElement.dataset.lumenCreator ?? null),
    plugins: Number((await page.locator('html').getAttribute('data-lumen-plugins')) ?? 0),
  }
}

async function propose(prompt) {
  const input = page.locator('[data-creator-composer] textarea').first()
  await input.fill(prompt)
  await input.press('Control+Enter')
  await waitCreatorState(['proposing', 'proposal-ready'], 40_000)
  await waitCreatorState('proposal-ready', 40_000)
  const proposalId = await page.locator('[data-creator-proposal]').first().getAttribute('data-creator-proposal')
  const capabilities = await page.locator('[data-permission]').count()
  const files = await page.locator('[data-creator-panel] [role="treeitem"]').count()
  const diffVisible = await page.locator('[data-creator-diff]').first().isVisible().catch(() => false)
  await shotSafe('03-creator-proposal')
  return { state: await creatorState(), proposalId, capabilities, files, diffVisible }
}

async function startTrial() {
  await page.getByRole('button', { name: '试跑', exact: true }).first().click()
  await waitCreatorState(['trialing', 'failed'], 30_000)
  const state = await creatorState()
  const deckWrites = await creatorAttr('data-creator-deck-writes')
  const plugins = Number((await page.locator('html').getAttribute('data-lumen-plugins')) ?? 0)
  await shotSafe('04-creator-trial')
  return { state, deckWrites, plugins, error: await creatorAttr('data-creator-error') }
}

async function revertTrial() {
  const slideBefore = await page.locator('.stage-frame .lumen-slide').first().innerText()
  await page.getByRole('button', { name: '撤销改造', exact: true }).first().click()
  await page.locator('[data-creator-confirm="revert"]').getByRole('button', { name: '撤销改造', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-creator-state]')?.getAttribute('data-creator-outcome') === 'reverted',
    undefined,
    { timeout: 30_000 },
  )
  const slideAfter = await page.locator('.stage-frame .lumen-slide').first().innerText()
  await shotSafe('05-creator-reverted')
  return {
    outcome: await creatorAttr('data-creator-outcome'),
    slideUnchanged: slideBefore === slideAfter,
    pendingWrites: await creatorAttr('data-creator-deck-writes'),
  }
}

async function keepTrial(pluginsBefore) {
  await page.getByRole('button', { name: '试跑', exact: true }).first().click()
  await waitCreatorState(['trialing', 'failed'], 30_000)
  assert((await creatorState()) === 'trialing', '第二次试跑应进入 trialing')
  await page.getByRole('button', { name: '保留', exact: true }).first().click()
  await waitCreatorState(['applied', 'failed'], 45_000)
  const state = await creatorState()
  const outcome = await creatorAttr('data-creator-outcome')
  const plugins = Number((await page.locator('html').getAttribute('data-lumen-plugins')) ?? 0)
  await shotSafe('06-creator-saved')
  return { state, outcome, pluginsBefore, pluginsAfter: plugins, error: await creatorAttr('data-creator-error') }
}

async function resumeAfterReload() {
  await page.goto(`${editorUrl('&creator=1')}`, { waitUntil: 'networkidle' })
  await waitFor(page.locator('[data-creator-panel]'), 25_000)
  await page.waitForFunction(
    () => document.querySelector('[data-creator-state]')?.getAttribute('data-creator-restored') === '1',
    undefined,
    { timeout: 20_000 },
  )
  const state = await creatorState()
  const outcome = await creatorAttr('data-creator-outcome')
  const restored = await creatorAttr('data-creator-restored')
  const trialInterrupted = await creatorAttr('data-creator-interrupted')
  await shotSafe('07-creator-resumed')
  return { state, outcome, restored, trialInterrupted }
}

/* ------------------------------- 请求统计 ------------------------------- */

async function summarizeMockRequests() {
  let lines = []
  try {
    lines = (await readFile(LLM_LOG, 'utf8')).split(/\r?\n/).filter(Boolean)
  } catch {
    lines = []
  }
  const summary = { total: 0, tasks: {}, intents: {}, repairs: 0, streams: 0 }
  const entries = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      entries.push(entry)
      summary.total += 1
      summary.tasks[entry.task] = (summary.tasks[entry.task] ?? 0) + 1
      if (entry.intent) summary.intents[entry.intent] = (summary.intents[entry.intent] ?? 0) + 1
      if (entry.repair) summary.repairs += 1
      if (entry.stream) summary.streams += 1
    } catch {
      /* 跳过坏行 */
    }
  }
  await writeFile(path.join(LLM_DIR, 'requests.pretty.json'), JSON.stringify(entries, null, 2))
  report.mockRequests = summary
  return summary
}

/* --------------------------------- 报告 --------------------------------- */

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])

async function writeReports() {
  await mkdir(OUT, { recursive: true })
  await writeFile(path.join(BROWSER_DIR, 'console.json'), JSON.stringify(report.errors.console, null, 2))
  await writeFile(path.join(BROWSER_DIR, 'page-errors.json'), JSON.stringify(report.errors.page, null, 2))
  await writeFile(path.join(BROWSER_DIR, 'failed-requests.json'), JSON.stringify(report.errors.failedRequests, null, 2))
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  const passed = report.steps.filter((entry) => entry.ok).length
  const totalMs = new Date(report.finishedAt) - new Date(report.startedAt)
  const rows = report.steps
    .map((entry) => {
      const status = entry.ok ? '✔' : '✘'
      const detail = entry.ok ? JSON.stringify(entry.detail ?? {}) : entry.error
      return `| ${status} | ${entry.id} | ${entry.title} | ${entry.ms}ms | ${detail.replace(/\|/g, '\\|').slice(0, 200)} |`
    })
    .join('\n')
  const intentRows = Object.entries(report.mockRequests.intents)
    .map(([intent, count]) => `| ${intent} | ${count} |`)
    .join('\n')
  const shotList = report.screenshots.map((file) => `![${path.basename(file)}](${file})`).join('\n\n')
  const assertionList = report.assertions.map((item) => `- ${item.message}`).join('\n')

  const markdown = `# LUMEN v0.4.0 · 创造模式模拟全链路报告

- 运行时间：${report.startedAt} → ${report.finishedAt}（${(totalMs / 1000).toFixed(1)}s）
- 页面：${report.base}（\`?still=1&onboard=0\`）
- 模拟端点：${report.llm.endpoint} · \`${report.llm.model}\`（OpenAI 兼容 · SSE）
- 步骤：**${passed} / ${report.steps.length} 通过**
- 断言：${report.assertions.length} 条
- 创造模式请求：${report.mockRequests.total} 次（intent ${JSON.stringify(report.mockRequests.intents)}，stream ${report.mockRequests.streams}）
- 截图：${report.screenshots.length} 张
- console error：${report.errors.console.length} · page error：${report.errors.page.length} · 失败请求：${report.errors.failedRequests.length}

## 步骤

| 状态 | id | 说明 | 耗时 | 证据 |
|---|---|---|---|---|
${rows}

## 断言

${assertionList || '（无）'}

## 提案意图分布

| intent | 次数 |
|---|---|
${intentRows || '| — | 0 |'}

## 截图

${shotList}
`
  await writeFile(path.join(OUT, 'report.md'), markdown)

  const cards = report.steps
    .map((entry) => {
      const detail = entry.ok ? JSON.stringify(entry.detail ?? {}) : entry.error
      return `<li class="${entry.ok ? 'ok' : 'bad'}"><b>${entry.ok ? 'PASS' : 'FAIL'}</b> <code>${escapeHtml(entry.id)}</code> ${escapeHtml(entry.title)} <span>${entry.ms}ms</span><pre>${escapeHtml(detail).slice(0, 500)}</pre></li>`
    })
    .join('\n')
  const gallery = report.screenshots
    .map((file) => `<figure><img src="${escapeHtml(file)}" alt="${escapeHtml(file)}"><figcaption>${escapeHtml(path.basename(file))}</figcaption></figure>`)
    .join('\n')
  const assertions = report.assertions.map((item) => `<li>${escapeHtml(item.message)}</li>`).join('\n')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LUMEN v0.4.0 · 创造模式模拟全链路</title>
<style>
:root{color-scheme:dark;--bg:#0b0d11;--panel:#141821;--line:#252b37;--fg:#e9edf5;--muted:#8b93a3;--accent:#6aa7ff;--ok:#55c98a;--bad:#e0746a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Segoe UI",system-ui,sans-serif;padding:48px 6vw}
h1{font-size:30px;margin:0 0 6px;letter-spacing:.03em}h2{margin-top:40px;font-size:17px;color:var(--accent);letter-spacing:.06em}
.lede{color:var(--muted);margin:0 0 26px}.stats{display:flex;gap:14px;flex-wrap:wrap;margin:22px 0}
.stat{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:12px 18px;min-width:140px}
.stat b{display:block;font-size:22px;color:var(--accent)}.stat span{color:var(--muted);font-size:11px;letter-spacing:.12em}
ul.steps{list-style:none;padding:0;display:grid;gap:8px}ul.steps li{border:1px solid var(--line);border-left:3px solid var(--ok);background:var(--panel);border-radius:8px;padding:10px 14px}
ul.steps li.bad{border-left-color:var(--bad)}ul.steps li b{font-size:10px;letter-spacing:.14em;color:var(--ok);margin-right:10px}ul.steps li.bad b{color:var(--bad)}
ul.steps code{color:var(--accent)}ul.steps span{color:var(--muted);font-size:11px;margin-left:8px}ul.steps pre{margin:6px 0 0;color:var(--muted);font-size:11px;white-space:pre-wrap}
ul.asserts{color:var(--muted);font-size:12.5px;line-height:1.8}
.gallery{columns:2;column-gap:14px}.gallery figure{margin:0 0 14px;break-inside:avoid;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.gallery img{display:block;width:100%;height:auto}.gallery figcaption{padding:6px 10px;color:var(--muted);font-size:11px}
</style>
<h1>LUMEN v0.4.0 · 创造模式模拟全链路</h1>
<p class="lede">一个真实的 OpenAI 兼容本地端点（SSE 流式）驱动了「安装 → 一句话提案 → 试跑 → 撤销 → 再试跑 → 保留 → 刷新恢复」。</p>
<div class="stats">
  <div class="stat"><b>${passed}/${report.steps.length}</b><span>步骤通过</span></div>
  <div class="stat"><b>${report.assertions.length}</b><span>断言</span></div>
  <div class="stat"><b>${report.mockRequests.total}</b><span>创造模式请求</span></div>
  <div class="stat"><b>${report.screenshots.length}</b><span>截图</span></div>
  <div class="stat"><b>${(totalMs / 1000).toFixed(1)}s</b><span>总耗时</span></div>
</div>
<h2>步骤</h2><ul class="steps">${cards}</ul>
<h2>断言</h2><ul class="asserts">${assertions || '<li>无</li>'}</ul>
<h2>证据截图</h2><div class="gallery">${gallery}</div>
</html>`
  await writeFile(path.join(OUT, 'report.html'), html)
  console.log(`\n${markdown.split('\n').slice(0, 16).join('\n')}`)
  console.log(`\n报告：${path.relative(ROOT, path.join(OUT, 'report.md'))} · ${path.relative(ROOT, path.join(OUT, 'report.html'))}`)
}

/* --------------------------------- 入口 --------------------------------- */

async function main() {
  await mkdir(SHOTS, { recursive: true })
  await mkdir(BROWSER_DIR, { recursive: true })
  await mkdir(LLM_DIR, { recursive: true })
  await writeFile(RUN_LOG, '')
  await writeFile(LLM_LOG, '').catch(() => {})
  await log(`LUMEN v0.4.0 创造模式模拟全链路开始 · base=${CFG.base} · mock=${report.llm.endpoint}`)
  const started = Date.now()

  await startMockCreator()
  await ensureDevServer()
  await launchBrowser()

  let failedExit = false
  try {
    await page.goto(editorUrl(), { waitUntil: 'networkidle' })
    await page.locator('.stage-frame .lumen-slide').first().waitFor({ timeout: 30_000 })

    await step('connect', '设置：把模型通道切到模拟创造端点并测试连通性', async () => {
      await configureLlm()
      await page.goto(editorUrl(), { waitUntil: 'networkidle' })
      return { endpoint: report.llm.endpoint, model: CFG.model }
    })

    const install = await step('install', '插件：安装三款内置样例（走真实安装管线）', installSamples)
    if (!install) throw new Error('插件安装失败，后续创造模式步骤跳过')
    assert(install.cards >= 3, `插件卡应 ≥3，实际 ${install.cards}`)
    report.creator.samplesInstalled = install.cards

    const opened = await step('creator.open', '创造模式：顶栏入口打开右侧面板（idle）', openCreator)
    if (!opened || opened.panel !== 1) throw new Error('创造面板未打开，后续步骤跳过')
    assert(opened.panel === 1, `面板应唯一，实际 ${opened.panel}`)
    assert(opened.dataset === '1', 'html[data-lumen-creator] 应为 "1"')
    assert(opened.state === 'idle', `初始状态应为 idle，实际 ${opened.state}`)
    assert(opened.plugins === 0, '样例默认不启用，data-lumen-plugins 应仍为 0')

    const proposal = await step('creator.propose', '一句话 → 模拟端点 plugin 任务 → 提案卡（文件树/diff/权限 chips）', () =>
      propose('给我一个暖色的主题皮肤'),
    )
    if (!proposal || proposal.proposalId === null) throw new Error('提案失败，后续步骤跳过')
    assert(proposal.proposalId?.startsWith('draft/'), `proposalId 形如 draft/<id>@<rev>，实际 ${proposal.proposalId}`)
    assert(proposal.capabilities >= 2, `权限 chips 应 ≥2，实际 ${proposal.capabilities}`)
    assert(proposal.diffVisible, '首次提案应显示 [data-creator-diff]（第一版提示）')
    assert(proposal.files >= 2, `文件树条目应 ≥2，实际 ${proposal.files}`)

    const trial = await step('creator.trial', '试跑：默认只读（不授权 deck:write、不计入插件启用数）', startTrial)
    if (!trial || trial.state !== 'trialing') throw new Error('试跑未进入 trialing，后续步骤跳过')
    assert(trial.state === 'trialing', `试跑状态应为 trialing，实际 ${trial.state}`)
    assert(trial.deckWrites === null, `只读试跑不应有 deck 写入，实际 ${trial.deckWrites}`)
    assert(trial.plugins === 0, `草稿帧不计入 data-lumen-plugins，实际 ${trial.plugins}`)

    const reverted = await step('creator.revert', '撤销改造：销毁帧 + 反注册 + deck 回到试跑前（reverted）', revertTrial)
    if (!reverted || reverted.outcome !== 'reverted') throw new Error('撤销未完成，后续步骤跳过')
    assert(reverted.outcome === 'reverted', `outcome 应为 reverted，实际 ${reverted.outcome}`)
    assert(reverted.slideUnchanged, '撤销后舞台文本应与试跑前一致')

    const kept = await step('creator.keep', '再试跑 → 保留：走安装管线并启用（applied + saved）', () => keepTrial(0))
    if (!kept) throw new Error('保留失败，后续步骤跳过')
    assert(kept.state === 'applied', `保留后对外状态应为 applied，实际 ${kept.state}`)
    assert(kept.outcome === 'saved', `outcome 应为 saved，实际 ${kept.outcome}`)
    assert(kept.pluginsAfter >= 1, `保留后插件启用数应 ≥1，实际 ${kept.pluginsAfter}`)

    const resumed = await step('creator.resume', '刷新恢复：不自动重挂试跑，终态 saved 保留', resumeAfterReload)
    if (!resumed) throw new Error('刷新恢复断言失败')
    assert(resumed.restored === '1', '应带 data-creator-restored="1"')
    assert(resumed.outcome === 'saved', `刷新后仍应 outcome=saved，实际 ${resumed.outcome}`)
    assert(resumed.trialInterrupted === null, '已 saved 的草稿不应标记试跑中断')

    await step('console.clean', '浏览器干净度：无 console error / page error / 失败请求', async () => {
      assert(report.errors.page.length === 0, `不应有 page error，实际 ${report.errors.page.length}`)
      assert(report.errors.console.length === 0, `不应有 console error，实际 ${report.errors.console.length}`)
      assert(report.errors.failedRequests.length === 0, `不应有失败请求，实际 ${report.errors.failedRequests.length}`)
      return { console: 0, page: 0, failedRequests: 0 }
    })

    const summary = await step('llm.contract', '模拟端点契约：请求全部是 plugin 任务、SSE 流式、提案可解析', async () => {
      const stats = await summarizeMockRequests()
      assert(stats.total >= 1, `模拟端点应至少收到 1 次请求，实际 ${stats.total}`)
      assert(Object.keys(stats.tasks).every((task) => task === 'plugin'), `只应有 plugin 任务，实际 ${JSON.stringify(stats.tasks)}`)
      assert(Object.keys(stats.intents).includes('theme'), `意图应命中 theme，实际 ${JSON.stringify(stats.intents)}`)
      return stats
    })
    void summary
  } catch (error) {
    failedExit = true
    await log(`RUNNER CRASH: ${error?.stack ?? error}`)
    report.crashed = String(error?.message ?? error)
  } finally {
    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.now() - started
    await summarizeMockRequests().catch(() => {})
    await writeReports().catch((error) => console.error('report write failed:', error))
    await browser?.close().catch(() => {})
    stopChildren()
  }

  const failed = report.steps.filter((entry) => !entry.ok)
  await log(`结束：${report.steps.length - failed.length}/${report.steps.length} 步通过，创造模式请求 ${report.mockRequests.total} 次`)
  if (failed.length > 0 || failedExit) {
    for (const entry of failed) console.error(`FAIL ${entry.id}: ${entry.error}`)
    process.exitCode = 1
  }
}

main().catch(async (error) => {
  console.error(error)
  await log(`RUNNER FATAL: ${error?.stack ?? error}`)
  stopChildren()
  process.exitCode = 1
})
