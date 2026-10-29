/**
 * standalone.ts —— 单文件 HTML 导出（产品最核心的交付物）。
 *
 * 目标：`file://` 双击就能播，且与编辑器同一渲染器、同一主题令牌，**零外部请求**。
 * 组成：
 *   1. `public/player/lumen-player.js`（IIFE，含 three）与 `lumen-player.css` 内联；
 *   2. 主题变量 `:root{--d-*}` 由 `themeCssVars()` 序列化（不依赖编辑器 CSS）；
 *   3. deck JSON 内联在 `<script type="application/json" id="lumen-deck">`；
 *   4. 素材：assetId → dataURL 内联在 `#lumen-assets`，播放器写进 `window.__LUMEN_ASSETS__`；
 *   5. 打印样式内联，同一文件支持 `?print=1` / `#print` 打印成 PDF。
 *
 * 体积护栏：素材先经 `assetCompress` 重采样为 ≤1920px WebP；>12MB 提示，>24MB 直接拒绝产出。
 */
import type { Deck } from '@/schema/deck'
import { slugify } from '@/schema/ids'
import { getTheme, themeCssVars, themeVarsCss } from '@/themes'
import { t } from '@/i18n'
import { collectAssetDataUrls } from '@/assets/assetStore'
import { collectAssetIds, triggerDownload } from './projectFile'
import { PRINT_CSS } from './printRoute'
import { compressDataUrlAssets } from './assetCompress'

/** 超过就提示（仍产出）。 */
export const STANDALONE_WARN_BYTES = 12 * 1024 * 1024
/** 超过就中止（不产出坏文件）。 */
export const STANDALONE_ABORT_BYTES = 24 * 1024 * 1024
/** 播放器内核产物路径（相对站点根）。 */
export const PLAYER_ASSET_BASE = 'player/lumen-player'

/**
 * 导出文件的 CSP：单文件 HTML 的卖点是"零外部请求"，所以默认全禁，只放行内联脚本/样式
 * 与 data:/blob: 图片（3D 抓帧、素材表都用 dataURL）。HTML 块的 iframe 走 srcdoc，
 * 继承本 CSP，`frame-src 'self'` 放行 about:srcdoc。
 */
export const STANDALONE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export interface StandaloneOptions {
  /** 内嵌讲者备注（默认 false：连数据都不进文件）。 */
  includeNotes?: boolean
  /** `<title>` 与文件名用的标题（缺省用 deck.title）。 */
  title?: string
  /** 文件名主干（缺省用 deck.title，panels 会传 slug 化的串）。 */
  fileName?: string
  /** panels 的开关：关闭时不内联素材（会给出 warning）。 */
  includeAssets?: boolean
  /** 内联前把大图重采样为 ≤1920px WebP（默认 true；导出弹窗可关）。 */
  compressAssets?: boolean
  /** panels 的范围开关；独立 HTML 始终是整份 deck。 */
  scope?: 'all' | 'current'
}

export interface StandaloneResult {
  html: string
  bytes: number
  warnings: string[]
}

/* ------------------------------- 文本工具 ------------------------------- */

/** 字节数（UTF-8）。 */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return new Blob([text]).size
}

/** 人类可读体积。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 把值序列化成可安全放进 `<script>` 的 JSON：
 * `<` `>` `&` 与 U+2028/U+2029 全部转成 \u 转义，
 * 这样 `</script>` 永远不会提前闭合标签，JSON.parse 结果保持原样。
 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** 内联 `<script>` 正文里的 `</script` 必须打断，否则标签提前结束。 */
export function escapeScriptText(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1')
}

/** 内联 `<style>` 正文里的 `</style` 同理。 */
export function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

/** 文件名：`slug.html`。 */
export function standaloneFileName(deck: Deck, options: StandaloneOptions = {}): string {
  const stem = slugify(options.fileName?.replace(/\.html?$/i, '') ?? deck.title ?? 'lumen-deck')
  return `${stem}.html`
}

/* -------------------------------- 内核读取 ------------------------------- */

/** 开发服会把未知路径回落到 index.html，所以还要看一眼内容像不像 JS/CSS。 */
function looksLikeHtmlDocument(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(text)
}

function playerMissingError(): Error {
  return new Error(`${t('export.playerMissing')} — ${t('export.playerMissingDetail')}`)
}

async function fetchPlayerAsset(kind: 'js' | 'css'): Promise<string> {
  if (typeof document === 'undefined') throw playerMissingError()
  const url = new URL(`${PLAYER_ASSET_BASE}.${kind}`, document.baseURI).toString()
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-cache' })
  } catch {
    throw playerMissingError()
  }
  if (!response.ok) throw playerMissingError()
  const text = await response.text()
  if (text.trim().length === 0 || looksLikeHtmlDocument(text)) throw playerMissingError()
  return text
}

/* -------------------------------- deck 副本 ------------------------------- */

/**
 * 播放器要用的 deck 副本：可选剔除讲者备注（不把作者私货带进导出文件）。
 * 其余字段一个不动——渲染器与导出端必须吃同一份数据。
 */
export function prepareStandaloneDeck(deck: Deck, options: StandaloneOptions = {}): Deck {
  const clone = JSON.parse(JSON.stringify(deck)) as Deck
  if (!options.includeNotes) {
    for (const slide of clone.slides) delete slide.notes
  }
  return clone
}

/* -------------------------------- HTML 骨架 ------------------------------- */

export interface ComposeInput {
  title: string
  deck: Deck
  assets: Record<string, string>
  playerJs: string
  playerCss: string
  themeCss: string
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 拼出最终 HTML（纯函数，便于单测）。 */
export function composeStandaloneHtml(input: ComposeInput): string {
  const { title, deck, assets, playerJs, playerCss, themeCss } = input
  const deckJson = escapeJsonForScript(deck)
  const assetsJson = escapeJsonForScript(assets)
  const css = escapeStyleText(playerCss)
  const theme = escapeStyleText(themeCss)
  const js = escapeScriptText(playerJs)
  const safeTitle = escapeHtmlText(title)
  // 标题会作为 JS 字符串字面量出现在内联脚本里：先 JSON 编码，再打断 `</script`。
  const bootTitle = escapeScriptText(JSON.stringify(title))
  const slideCount = deck.slides.length

  return `<!doctype html>
<!-- LUMEN / 幕光 — Copyright (c) 2026 无极Ayaya.
     Source: Apache-2.0 + Commons Clause (see LICENSE in the repository).
     Design assets and sample copy: CC BY-NC 4.0. "LUMEN" is a trademark of the author. -->
<html lang="${deck.lang === 'en' ? 'en' : 'zh-CN'}" data-lumen-standalone="1" data-lumen-slides="${slideCount}" data-lumen-theme="${escapeHtmlText(deck.themeId)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<meta name="generator" content="LUMEN · 幕光" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlText(STANDALONE_CSP)}" />
<title>${safeTitle}</title>
<style id="lumen-theme">${theme}
html,body{margin:0;height:100%;background:#000;overflow:hidden;}
#lumen-root{position:fixed;inset:0;}
</style>
<style id="lumen-player-css">${css}</style>
<style id="lumen-print-css">${escapeStyleText(PRINT_CSS)}</style>
</head>
<body>
<div id="lumen-root" data-lumen-root="1">正在载入演示…</div>
<script type="application/json" id="lumen-assets">${assetsJson}</script>
<script type="application/json" id="lumen-deck">${deckJson}</script>
<script id="lumen-player-js">${js}</script>
<script id="lumen-boot">
(function () {
  var root = document.getElementById('lumen-root');
  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (error) {
      console.error('[lumen] 内联数据解析失败：' + id, error);
      return null;
    }
  }
  var deck = readJson('lumen-deck');
  var assets = readJson('lumen-assets') || {};
  var api = window.LumenPlayer;
  if (!deck || !api || typeof api.mount !== 'function') {
    if (root) root.textContent = '播放器未能载入：内联脚本缺失或数据损坏。';
    return;
  }
  var search = String(location.search || '');
  var hash = String(location.hash || '');
  var printing = /(^|[?&])print=1(&|$)/.test(search) || hash === '#print';
  try {
    api.mount(root, deck, { assets: assets, print: printing, title: ${bootTitle} });
  } catch (error) {
    console.error('[lumen] 播放器启动失败', error);
    if (root) root.textContent = '播放器启动失败：' + (error && error.message ? error.message : error);
  }
})();
</script>
</body>
</html>
`
}

/* --------------------------------- 主流程 -------------------------------- */

/**
 * 体积护栏：>12MB 提示（仍产出），>24MB 直接抛错（不产出坏文件）。
 * 抽成纯函数便于单测——真造一个 24MB 的 deck 成本太高。
 */
export function checkStandaloneSize(bytes: number): string[] {
  if (bytes > STANDALONE_ABORT_BYTES) {
    throw new Error(
      t('export.tooLarge', {
        size: formatBytes(bytes),
        max: formatBytes(STANDALONE_ABORT_BYTES),
      }),
    )
  }
  if (bytes > STANDALONE_WARN_BYTES) {
    return [t('export.sizeWarning', { size: formatBytes(bytes) })]
  }
  return []
}

/**
 * 构建单文件 HTML。播放器内核缺失时抛错（绝不静默产出坏文件）。
 */
export async function buildStandaloneHtml(
  deck: Deck,
  options: StandaloneOptions = {},
): Promise<StandaloneResult> {
  const warnings: string[] = []

  const [playerJs, playerCss] = await Promise.all([fetchPlayerAsset('js'), fetchPlayerAsset('css')])

  const assetIds = collectAssetIds(deck)
  let assets: Record<string, string> = {}
  if (assetIds.length > 0) {
    if (options.includeAssets === false) {
      warnings.push(t('export.warnAssetsSkipped'))
    } else {
      assets = await collectAssetDataUrls(assetIds)
      const missing = Array.from(new Set(assetIds)).filter((id) => !assets[id])
      if (missing.length > 0) {
        warnings.push(t('export.warnAssetMissing', { count: missing.length }))
      }
      if (options.compressAssets !== false && Object.keys(assets).length > 0) {
        const report = await compressDataUrlAssets(assets)
        assets = report.assets
        if (report.failed.length > 0) {
          warnings.push(t('export.warnAssetCompress', { count: report.failed.length }))
        }
        if (report.savedBytes > 0) {
          warnings.push(t('export.assetOptimized', { saved: formatBytes(report.savedBytes) }))
        }
      }
    }
  }

  const shipped = prepareStandaloneDeck(deck, options)
  const theme = getTheme(deck.themeId)
  const themeCss = themeVarsCss(themeCssVars(theme, deck.themeOverrides))
  const title = (options.title?.trim() || deck.title || 'LUMEN').trim()

  const html = composeStandaloneHtml({
    title,
    deck: shipped,
    assets,
    playerJs,
    playerCss,
    themeCss,
  })
  const bytes = byteLength(html)
  warnings.push(...checkStandaloneSize(bytes))

  return { html, bytes, warnings }
}

/** 构建并触发下载。 */
export async function exportStandaloneHtml(
  deck: Deck,
  options: StandaloneOptions = {},
): Promise<void> {
  const result = await buildStandaloneHtml(deck, options)
  const blob = new Blob([result.html], { type: 'text/html;charset=utf-8' })
  triggerDownload(blob, standaloneFileName(deck, options))
}

/* ----------------------------- panels 命名兼容 ---------------------------- */
/** exporterBridge 的候选名（按优先级 exportStandalone → buildStandalone → …）。 */
export const exportStandalone = exportStandaloneHtml
export const buildStandalone = buildStandaloneHtml
export const exportHtml = exportStandaloneHtml
