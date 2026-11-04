#!/usr/bin/env node
/**
 * scripts/budget-check.mjs —— G3 构建/体积/懒加载门禁（T-40-32，06 §2/§4.5）。
 *
 * 前置：`pnpm build`（或 `node node_modules/vite/bin/vite.js build`）已产出 dist/；
 *       本机必须带 TEMP 覆盖（见 plan/v0.4.0/assets/baseline/README.md §2）。
 *
 * 基线文件：`scripts/baseline-v030.json`（v0.3.0 实测首屏基线，随仓库提交，
 *           CI 可用；plan/ 只在本地保留、不入库，故不再依赖 plan 内文件）。
 *           0.4.0 当前数据由脚本写到 plan/v0.4.0/assets/budget-current.json（本地证据）。
 *
 * 判据（G3，Lead 2026-11-03 裁定）：
 *  a) 首屏 gzip 增量 ≤ 45 KB（十进制 45,000 B，硬上限 = 基线 + 45,000）；
 *     「首屏」= dist/index.html + 其 script/modulepreload/stylesheet 引用的本地资源，逐文件 gzip(level 9) 求和；
 *  b) 播放器三条：(b1) dist/player 与 public/player 字节一致（构建拷贝链正确）；
 *     (b2) 播放器产物可由源码确定性重建（本脚本只记录哈希；确定性由 CI 跑两次 build:player 对拍）；
 *     (c) 播放器产物不含插件运行时标记（插件不得进播放器/导出内核）；
 *  c) 插件懒加载：runtime / PluginManager / Creator / boot 必须是独立 chunk 且不出现在首屏引用里；
 *     首屏 JS 不得包含插件帧协议独有的重代码标记。
 *
 * 输出：PASS/FAIL 表 + plan/v0.4.0/assets/budget-current.json（证据）。退出码 1 = 有 FAIL。
 *
 * 用法：node scripts/budget-check.mjs [--dist dist] [--baseline path] [--out path]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const DIST = join(root, arg('dist', 'dist'))
const BASELINE_PATH = join(root, arg('baseline', 'scripts/baseline-v030.json'))
const OUT_PATH = join(root, arg('out', 'plan/v0.4.0/assets/budget-current.json'))

/** 首屏 gzip 预算（十进制 45 KB，从严；见 baseline README §3.3）。 */
const FIRST_SCREEN_BUDGET_BYTES = 45_000
/** boot.ts 若进入首屏，gzip 上限 0.8 KiB（02 §10.3）；懒加载则免检。 */
const BOOT_FIRST_SCREEN_LIMIT_BYTES = 819

const results = []
function check(id, title, pass, detail) {
  results.push({ id, title, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `  — ${detail}` : ''}`)
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`
const signed = (bytes) => `${bytes >= 0 ? '+' : ''}${(bytes / 1024).toFixed(2)} KiB`

/* ------------------------------ 1) 首屏体积 ------------------------------ */

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`dist/index.html not found under ${DIST}; run build first`)
  process.exit(2)
}
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null
if (!baseline || typeof baseline.firstScreenGzip !== 'number') {
  console.error(`baseline sizes json not found or lacks firstScreenGzip: ${BASELINE_PATH}`)
  process.exit(2)
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const refs = []
for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) refs.push({ kind: 'script', href: m[1] })
for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
  const tag = m[0]
  const rel = (tag.match(/\brel=["']([^"']+)["']/i) ?? [])[1]?.toLowerCase() ?? ''
  const href = (tag.match(/\bhref=["']([^"']+)["']/i) ?? [])[1] ?? ''
  const as = (tag.match(/\bas=["']([^"']+)["']/i) ?? [])[1]?.toLowerCase() ?? ''
  if (rel === 'modulepreload') refs.push({ kind: 'modulepreload', href })
  else if (rel === 'stylesheet') refs.push({ kind: 'stylesheet', href })
  else if (rel === 'preload' && (as === 'script' || as === 'style')) refs.push({ kind: `preload:${as}`, href })
}

const firstScreen = []
const seen = new Set()
for (const ref of refs) {
  const clean = ref.href.replace(/^\.\//, '').split('?')[0]
  if (/^(https?:|data:|blob:)/i.test(clean)) continue
  const abs = join(DIST, clean)
  if (!existsSync(abs) || seen.has(clean)) continue
  seen.add(clean)
  const buf = readFileSync(abs)
  firstScreen.push({ kind: ref.kind, file: clean, raw: buf.length, gzip: gz(buf) })
}
const htmlBuf = readFileSync(join(DIST, 'index.html'))
const htmlGzip = gz(htmlBuf)
const firstScreenGzip = htmlGzip + firstScreen.reduce((sum, row) => sum + row.gzip, 0)
const delta = firstScreenGzip - baseline.firstScreenGzip
const limit = baseline.firstScreenGzip + FIRST_SCREEN_BUDGET_BYTES

check(
  'G3-a 首屏增量',
  `首屏 gzip ${firstScreenGzip} B（${kb(firstScreenGzip)}）≤ 上限 ${limit} B`,
  firstScreenGzip <= limit,
  `基线 ${baseline.firstScreenGzip} B，增量 ${signed(delta)}，预算 +${kb(FIRST_SCREEN_BUDGET_BYTES)}`,
)

/** 逻辑 chunk 名（去掉 content hash）：`main-BBlX1Owo.js` → `main.js`。 */
function logicalName(file) {
  return file.replace(/-[A-Za-z0-9_-]{8,}\./, '.')
}
const group = (rows) => {
  const map = new Map()
  for (const row of rows) {
    const name = logicalName(row.file.split('/').pop())
    const prev = map.get(name) ?? { raw: 0, gzip: 0 }
    map.set(name, { raw: prev.raw + row.raw, gzip: prev.gzip + row.gzip })
  }
  return map
}
const currentGroups = group([{ file: 'index.html', raw: htmlBuf.length, gzip: htmlGzip }, ...firstScreen])
const baselineGroups = group([
  { file: 'index.html', raw: baseline.html?.raw ?? 0, gzip: baseline.html?.gzip ?? 0 },
  ...(baseline.firstScreenAssets ?? []),
])
const groupDeltas = {}
for (const [name, current] of [...currentGroups.entries()].sort((a, b) => b[1].gzip - a[1].gzip)) {
  const before = baselineGroups.get(name)?.gzip ?? 0
  groupDeltas[name] = { before, now: current.gzip, delta: current.gzip - before }
}

/* ------------------------------ 2) 懒加载 ------------------------------ */

const assetFiles = existsSync(join(DIST, 'assets'))
  ? readdirSync(join(DIST, 'assets')).filter((name) => /\.(js|css)$/.test(name))
  : []
const firstScreenFiles = new Set(firstScreen.map((row) => row.file.split('/').pop()))

const lazyExpectations = [
  ['插件运行时', /^runtime-.*\.js$/],
  ['插件管理器', /^PluginManagerDialog-.*\.js$/],
  ['创造模式面板', /^CreatorSurface-.*\.js$/],
]
const lazyReport = []
for (const [label, pattern] of lazyExpectations) {
  const found = assetFiles.filter((name) => pattern.test(name))
  const inFirstScreen = found.filter((name) => firstScreenFiles.has(name))
  lazyReport.push({ label, files: found, inFirstScreen })
  check(
    `G3-c ${label}懒加载`,
    `${label}是独立 chunk 且不在首屏引用中（${found.join(', ') || '缺失'}）`,
    found.length > 0 && inFirstScreen.length === 0,
    inFirstScreen.length > 0 ? `首屏引用了 ${inFirstScreen.join(', ')}` : undefined,
  )
}

// boot：允许打成独立动态 chunk，但若进入首屏则必须 ≤0.8KB
const bootFile = assetFiles.find((name) => /^boot-.*\.js$/.test(name))
if (bootFile) {
  const bootGzip = gz(readFileSync(join(DIST, 'assets', bootFile)))
  const inFirstScreen = firstScreenFiles.has(bootFile)
  check(
    'G3-c boot 首屏成本',
    inFirstScreen ? `boot 首屏 gzip ${bootGzip} B ≤ ${BOOT_FIRST_SCREEN_LIMIT_BYTES} B` : 'boot 为懒加载独立 chunk（首屏 0 字节）',
    inFirstScreen ? bootGzip <= BOOT_FIRST_SCREEN_LIMIT_BYTES : true,
    inFirstScreen ? undefined : `${bootFile} gzip ${bootGzip} B，非首屏引用`,
  )
} else {
  check('G3-c boot 首屏成本', 'boot 已打进主 chunk（≤0.8KB 需人工看主 chunk 增量）', true)
}

/**
 * 首屏 JS 不得包含插件宿主重代码标记（否则说明 runtime/host 被静态并入）。
 * 注意：`allow-scripts` / `lumen-sdk.css` 在 v0.3.0 既有 HTML 块渲染器与创造模式提示词里也会出现，
 * 不能作为判据；这里用插件帧协议独有字段（frameNonce / data-plugin-frame / about:srcdoc）。
 */
const HEAVY_MARKERS = ['about:srcdoc', 'data-plugin-frame', 'frameNonce', 'pluginFrameNonce']
const firstScreenJs = firstScreen.filter((row) => row.file.endsWith('.js'))
const leakedMarkers = []
for (const row of firstScreenJs) {
  const text = readFileSync(join(DIST, row.file), 'utf8')
  for (const marker of HEAVY_MARKERS) {
    if (text.includes(marker)) leakedMarkers.push(`${row.file}:${marker}`)
  }
}
check(
  'G3-c 首屏无插件宿主代码',
  `首屏 JS 不含 host 标记（${HEAVY_MARKERS.join(' / ')}）`,
  leakedMarkers.length === 0,
  leakedMarkers.join(', '),
)

/* ------------------------------ 3) 播放器内核 ------------------------------ */

function hashTree(dir) {
  const out = {}
  if (!existsSync(dir)) return out
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else {
        const buf = readFileSync(abs)
        out[relative(dir, abs).replace(/\\/g, '/')] = { sha256: sha256(buf), size: buf.length }
      }
    }
  }
  walk(dir)
  return out
}
const publicPlayer = hashTree(join(root, 'public', 'player'))
const distPlayer = hashTree(join(DIST, 'player'))
const samePlayer = JSON.stringify(publicPlayer) === JSON.stringify(distPlayer)
check(
  'G3-b1 播放器拷贝链',
  'dist/player 与 public/player 字节一致',
  samePlayer && Object.keys(publicPlayer).length > 0,
  samePlayer ? Object.keys(publicPlayer).join(', ') : '构建产物与 public/player 不一致（请先 node scripts/build-player.mjs 再 build）',
)

const PLAYER_FORBIDDEN = ['PLUGIN_CSP', 'about:srcdoc', 'data-plugin-frame', 'lumen-plugin']
const playerLeaks = []
for (const [file] of Object.entries(distPlayer)) {
  if (!file.endsWith('.js')) continue
  const text = readFileSync(join(DIST, 'player', file), 'utf8')
  for (const marker of PLAYER_FORBIDDEN) if (text.includes(marker)) playerLeaks.push(`${file}:${marker}`)
}
check(
  'G3-c 播放器不含插件运行时',
  `播放器产物不含插件运行时标记（${PLAYER_FORBIDDEN.join(' / ')}）`,
  playerLeaks.length === 0,
  playerLeaks.join(', '),
)

// 超大 chunk 观测（vite chunkSizeWarningLimit = 1200 KiB；超出即构建会告警）
const oversized = assetFiles
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, raw: statSync(join(DIST, 'assets', name)).size }))
  .filter((row) => row.raw > 1200 * 1024)
check(
  'G3 无超大 chunk',
  '所有 JS chunk raw ≤ 1200 KiB（chunkSizeWarningLimit）',
  oversized.length === 0,
  oversized.map((row) => `${row.name}:${kb(row.raw)}`).join(', '),
)

/* ------------------------------ 4) 证据落盘 ------------------------------ */

const report = {
  sampledAt: new Date().toISOString(),
  dist: relative(root, DIST).replace(/\\/g, '/'),
  baseline: {
    file: relative(root, BASELINE_PATH).replace(/\\/g, '/'),
    sampledAt: baseline.sampledAt,
    firstScreenGzip: baseline.firstScreenGzip,
  },
  firstScreen: {
    gzip: firstScreenGzip,
    raw: htmlBuf.length + firstScreen.reduce((sum, row) => sum + row.raw, 0),
    budgetBytes: FIRST_SCREEN_BUDGET_BYTES,
    delta,
    limit,
    assets: firstScreen,
    groupDeltas,
  },
  lazyChunks: lazyReport,
  heavyMarkersInFirstScreen: leakedMarkers,
  player: {
    publicPlayer,
    distPlayer,
    identical: samePlayer,
    pluginRuntimeLeaks: playerLeaks,
  },
  gates: results,
  pass: results.every((row) => row.pass),
}
writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`)

/* ------------------------------ 5) 汇总输出 ------------------------------ */

console.log('')
console.log('首屏分项（gzip，bytes）：')
for (const row of firstScreen) console.log(`  ${String(row.gzip).padStart(7)} B  ${row.file}`)
console.log(`  ${String(htmlGzip).padStart(7)} B  index.html`)
console.log('')
console.log('首屏 chunk 增量（按逻辑名）：')
for (const [name, row] of Object.entries(groupDeltas)) {
  if (row.delta === 0) continue
  console.log(`  ${signed(row.delta).padStart(12)}  ${name}  (${row.before} → ${row.now} B gzip)`)
}
console.log('')
const failed = results.filter((row) => !row.pass)
console.log(`BUDGET ${failed.length === 0 ? 'PASS' : 'FAIL'}（${results.length - failed.length}/${results.length} 项通过）`)
console.log(`report: ${relative(root, OUT_PATH).replace(/\\/g, '/')}`)
process.exit(failed.length === 0 ? 0 : 1)
