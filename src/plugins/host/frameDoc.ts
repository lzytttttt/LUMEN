/**
 * plugins/host/frameDoc.ts —— 沙箱帧 srcdoc 拼装（02 §4.2，纯函数、可单测）。
 *
 * 安全红线（不要改）：
 * - `PLUGIN_CSP` 逐字使用 02 §4.2 / 03 §4.3 的冻结串；只比 `STANDALONE_CSP` 多
 *   `child-src/worker-src/manifest-src 'none'`，且 `frame-src 'none'`、无 `blob:`、无 `'unsafe-eval'`。
 * - 插件源码只作为**一个内联 `<script type="module">`** 注入；不 import、不 blob、无二次模块。
 * - `<` `>` `&`/U+2028/U+2029 由 `escapeJsonForScript` 处理，`</script`、`</style` 由
 *   `escapeScriptText`/`escapeStyleText` 打断；宿主注入的 JSON 永不提前闭合标签。
 *
 * 本文件只做字符串拼装与令牌快照；帧生命周期在 `PluginHost.tsx`，客户端在 `inject.ts`。
 */
import { escapeJsonForScript, escapeScriptText, escapeStyleText } from '@/export/standalone'
import type { Lang } from '@/i18n/types'
import { getTheme, themeCssVars } from '@/themes'
import type { Capability, SlotId } from '../types'

/* ------------------------------ 冻结常量 ------------------------------ */

/** 02 §4.2 冻结（逐字；不要重排/增删）。 */
export const PLUGIN_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  'img-src data: blob:; font-src data:; media-src data: blob:; ' +
  "connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'"

/** 帧文档的结构版本（测试用）。 */
export const FRAME_DOC_VERSION = 1

/**
 * 追加到插件入口源码末尾的「模块求值完成」哨兵。
 * 顶层 `throw`/语法错时它不会执行 → bootstrap 在 `load` 时判定启动失败（`E-RUN-02`），
 * 避免「模块已崩但 load 仍触发 → 误发 __ready → 状态机不记失败、永远不隔离」（E-40-10/10b）。
 */
export const PLUGIN_EVALUATED_SENTINEL = '\n;window.__LUMEN_PLUGIN_EVALUATED__=true;\n'
export const PLUGIN_EVALUATED_FLAG = '__LUMEN_PLUGIN_EVALUATED__'

/** `lumen.ui.css` 单次注入上限（02 §4.4 单条消息 ≤64KB 的帧内预检）。 */
export const FRAME_CSS_MAX_BYTES = 64 * 1024

/* ------------------------------ 令牌快照 ------------------------------ */

/** 界面铬令牌（与 `src/styles/tokens.css` 的 `--ui-*` 对齐；插件 UI 只用这些，不碰 `--d-*` 语义外的变量）。 */
export const UI_TOKEN_NAMES: readonly string[] = [
  '--ui-bg',
  '--ui-bg-2',
  '--ui-panel',
  '--ui-panel-2',
  '--ui-elev',
  '--ui-hover',
  '--ui-active',
  '--ui-line',
  '--ui-line-strong',
  '--ui-fg',
  '--ui-fg-dim',
  '--ui-fg-mute',
  '--ui-fg-invert',
  '--ui-accent',
  '--ui-accent-2',
  '--ui-accent-soft',
  '--ui-accent-line',
  '--ui-danger',
  '--ui-danger-soft',
  '--ui-ok',
  '--ui-warn',
  '--ui-info',
  '--ui-canvas',
  '--ui-stage-shadow',
  '--ui-radius',
  '--ui-radius-sm',
  '--ui-radius-xs',
  '--ui-shadow',
  '--ui-shadow-sm',
  '--ui-font',
  '--ui-font-mono',
]

/**
 * 当前帧的令牌快照：`--ui-*`（读宿主 computedStyle）+ 当前 deck 主题的 `--d-*`（含用户 override）。
 * 非浏览器环境（单测）返回主题变量，UI 令牌为空（帧文档仍可用）。
 */
export function collectFrameTokens(themeId: string, overrides?: Record<string, string>): Record<string, string> {
  const tokens: Record<string, string> = {}
  const theme = getTheme(themeId)
  const themeOverrides =
    overrides && Object.keys(overrides).length > 0
      ? (overrides as unknown as Parameters<typeof themeCssVars>[1])
      : undefined
  Object.assign(tokens, themeCssVars(theme, themeOverrides))
  if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    const computed = getComputedStyle(document.documentElement)
    for (const name of UI_TOKEN_NAMES) {
      const value = computed.getPropertyValue(name)
      if (value) tokens[name] = value.trim()
    }
  }
  return tokens
}

/** 令牌表 → `:root{--a:b;...}`（值里已有的 `;`/`}` 由样式转义兜住）。 */
export function tokensCss(tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .filter(([name, value]) => /^--[a-z0-9-]+$/i.test(name) && typeof value === 'string' && value.trim() !== '')
    .map(([name, value]) => `${name}:${value.trim()};`)
    .join('')
  return `:root{${body}}`
}

/* ------------------------------ SDK CSS（16 个基元） ------------------------------ */

/**
 * `lumen-sdk.css`（02 §5.6 的 16 个基元）。
 * 只用 `--ui-*` / `--d-*` 令牌，不自带颜色字面量；根节点 `data-sdk="v1"`；焦点环与 reduced-motion 与宿主同族。
 */
export const LUMEN_SDK_CSS = `
:where([data-sdk="v1"]){box-sizing:border-box;color:var(--ui-fg);font:12.5px/1.55 var(--ui-font);-webkit-font-smoothing:antialiased}
:where([data-sdk="v1"] *,:where([data-sdk="v1"]) *::before,:where([data-sdk="v1"]) *::after){box-sizing:border-box}
:where([data-sdk="v1"]) :focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px;border-radius:var(--ui-radius-xs)}
:where([data-sdk="v1"]) .lumen-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border-radius:var(--ui-radius-sm);border:1px solid var(--ui-line-strong);background:var(--ui-panel-2);color:var(--ui-fg);font:inherit;cursor:pointer;transition:background var(--dur-fast) var(--ease),border-color var(--dur-fast) var(--ease)}
:where([data-sdk="v1"]) .lumen-button:hover{background:var(--ui-hover)}
:where([data-sdk="v1"]) .lumen-button:active{background:var(--ui-active)}
:where([data-sdk="v1"]) .lumen-button[disabled]{opacity:.5;cursor:default}
:where([data-sdk="v1"]) .lumen-button--primary{background:var(--ui-accent);border-color:var(--ui-accent);color:var(--ui-fg-invert)}
:where([data-sdk="v1"]) .lumen-button--primary:hover{background:var(--ui-accent);filter:brightness(1.06)}
:where([data-sdk="v1"]) .lumen-button--ghost{background:transparent;border-color:transparent;color:var(--ui-fg-dim)}
:where([data-sdk="v1"]) .lumen-button--ghost:hover{background:var(--ui-hover);color:var(--ui-fg)}
:where([data-sdk="v1"]) .lumen-button--danger{background:transparent;border-color:var(--ui-danger);color:var(--ui-danger)}
:where([data-sdk="v1"]) .lumen-iconButton{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--ui-radius-sm);border:1px solid transparent;background:transparent;color:var(--ui-fg-dim);cursor:pointer;font:inherit}
:where([data-sdk="v1"]) .lumen-iconButton:hover{background:var(--ui-hover);color:var(--ui-fg)}
:where([data-sdk="v1"]) .lumen-field{display:flex;flex-direction:column;gap:4px;min-width:0}
:where([data-sdk="v1"]) .lumen-field__label{color:var(--ui-fg-mute);font-size:11px}
:where([data-sdk="v1"]) .lumen-textInput,:where([data-sdk="v1"]) .lumen-textarea,:where([data-sdk="v1"]) .lumen-select{width:100%;min-width:0;border:1px solid var(--ui-line-strong);border-radius:var(--ui-radius-sm);background:var(--ui-bg-2);color:var(--ui-fg);font:inherit;padding:5px 8px}
:where([data-sdk="v1"]) .lumen-textInput:focus,:where([data-sdk="v1"]) .lumen-textarea:focus,:where([data-sdk="v1"]) .lumen-select:focus{border-color:var(--ui-accent);outline:none}
:where([data-sdk="v1"]) .lumen-textarea{min-height:64px;resize:vertical;font-family:var(--ui-font-mono)}
:where([data-sdk="v1"]) .lumen-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
:where([data-sdk="v1"]) .lumen-switch input{position:absolute;opacity:0;width:1px;height:1px}
:where([data-sdk="v1"]) .lumen-switch__track{width:30px;height:18px;border-radius:999px;background:var(--ui-line-strong);transition:background var(--dur-fast) var(--ease)}
:where([data-sdk="v1"]) .lumen-switch input:checked + .lumen-switch__track{background:var(--ui-accent)}
:where([data-sdk="v1"]) .lumen-slider{width:100%;accent-color:var(--ui-accent)}
:where([data-sdk="v1"]) .lumen-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:var(--ui-radius-sm);background:var(--ui-bg-2)}
:where([data-sdk="v1"]) .lumen-tabs [role="tab"]{border:0;background:transparent;color:var(--ui-fg-dim);font:inherit;padding:3px 9px;border-radius:var(--ui-radius-xs);cursor:pointer}
:where([data-sdk="v1"]) .lumen-tabs [role="tab"][aria-selected="true"]{background:var(--ui-elev);color:var(--ui-fg)}
:where([data-sdk="v1"]) .lumen-card{border:1px solid var(--ui-line);border-radius:var(--ui-radius);background:var(--ui-panel);padding:10px;display:flex;flex-direction:column;gap:8px}
:where([data-sdk="v1"]) .lumen-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:999px;background:var(--ui-accent-soft);border:1px solid var(--ui-accent-line);color:var(--ui-fg-dim);font-size:10.5px;letter-spacing:.02em}
:where([data-sdk="v1"]) .lumen-badge--ok{background:color-mix(in srgb,var(--ui-ok) 14%,transparent);border-color:color-mix(in srgb,var(--ui-ok) 34%,transparent);color:var(--ui-ok)}
:where([data-sdk="v1"]) .lumen-badge--warn{background:color-mix(in srgb,var(--ui-warn) 14%,transparent);border-color:color-mix(in srgb,var(--ui-warn) 34%,transparent);color:var(--ui-warn)}
:where([data-sdk="v1"]) .lumen-badge--danger{background:color-mix(in srgb,var(--ui-danger) 14%,transparent);border-color:color-mix(in srgb,var(--ui-danger) 34%,transparent);color:var(--ui-danger)}
:where([data-sdk="v1"]) .lumen-toast{padding:7px 10px;border-radius:var(--ui-radius-sm);border:1px solid var(--ui-line-strong);background:var(--ui-elev);color:var(--ui-fg);font-size:12px}
:where([data-sdk="v1"]) .lumen-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:120px;border:1px dashed var(--ui-line-strong);border-radius:var(--ui-radius);color:var(--ui-fg-dim);text-align:center;padding:14px}
:where([data-sdk="v1"]) .lumen-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--ui-line-strong);border-top-color:var(--ui-accent);animation:lumen-spin 720ms linear infinite}
@keyframes lumen-spin{to{transform:rotate(360deg)}}
:where([data-sdk="v1"]) .lumen-codeBlock{margin:0;padding:8px 10px;border-radius:var(--ui-radius-sm);background:var(--ui-bg-2);border:1px solid var(--ui-line);font:11.5px/1.5 var(--ui-font-mono);color:var(--ui-fg-dim);overflow:auto;white-space:pre-wrap;word-break:break-word}
:where([data-sdk="v1"]) .lumen-table{width:100%;border-collapse:collapse;font-size:12px}
:where([data-sdk="v1"]) .lumen-table th,:where([data-sdk="v1"]) .lumen-table td{padding:4px 7px;border-bottom:1px solid var(--ui-line);text-align:left;vertical-align:top}
:where([data-sdk="v1"]) .lumen-table th{color:var(--ui-fg-mute);font-weight:600}
@media (prefers-reduced-motion:reduce){:where([data-sdk="v1"]) *{animation-duration:1ms !important;transition-duration:1ms !important}}
`;

/* ------------------------------ 帧内 i18n 包 ------------------------------ */

/** 清单声明语言包（相对键）→ 帧内查找用包（不做前缀，客户端对相对键做 `plugin.<id>.` 前缀）。 */
export interface FrameLocalePack {
  zh: Record<string, string>
  en: Record<string, string>
}

export function emptyFrameLocalePack(): FrameLocalePack {
  return { zh: {}, en: {} }
}

/* ------------------------------ 帧文档输入 ------------------------------ */

/** 帧的归属信息（拼文档 + 客户端 boot payload 共用）。 */
export interface FrameDocInput {
  pluginId: string
  pluginKind: 'declarative' | 'code'
  pluginVersion: string
  apiVersion: '1.0'
  appVersion: string
  /** 帧所属插槽（`dialog`/`settings.page`/`workspace.*`；命令面板无帧）。 */
  slot: SlotId
  contributionId: string
  /** 帧标题（iframe `title` 与客户端 `ui.setTitle` 默认值）。 */
  title: string
  frameNonce: string
  entryPath: string
  entrySource: string
  locale: Lang
  lang: Lang
  uiTheme: 'dark' | 'light'
  reducedMotion: boolean
  density: 'comfortable' | 'compact'
  /** 只读能力列表（**不含 grants**：插件看不到授权对象，调用凭 frameNonce 实时判定）。 */
  capabilities: readonly Capability[]
  tokens: Record<string, string>
  /** 清单声明语言包（可选）。 */
  localePack?: FrameLocalePack | null
  /** 宿主 bootstrap 源码（`inject.ts#composeBootstrapScript()`）。 */
  bootstrap: string
  /** 十六进制色板/几何等额外 env（可选；例如 onRender ctx 的 width/height）。 */
  size?: { w?: number; h?: number }
}

/** 客户端 boot payload（`window.__LUMEN_BOOT__` 的形状；02 §4.3 第 1 条）。 */
export interface FrameBootData {
  v: 1
  pluginId: string
  pluginVersion: string
  apiVersion: '1.0'
  appVersion: string
  locale: Lang
  capabilities: string[]
  frameNonce: string
  entryPath: string
  slot: SlotId
  contributionId: string
  kind: 'inline' | 'panel' | 'overlay' | 'modal'
  title: string
  tokens: Record<string, string>
  i18n: FrameLocalePack
  size?: { w?: number; h?: number }
}

/** 由帧输入生成客户端 boot payload（纯函数；测试直接用）。 */
export function composeBootData(input: FrameDocInput): FrameBootData {
  const kind = slotKindOf(input.slot)
  const data: FrameBootData = {
    v: 1,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    apiVersion: input.apiVersion,
    appVersion: input.appVersion,
    locale: input.locale,
    capabilities: [...input.capabilities],
    frameNonce: input.frameNonce,
    entryPath: input.entryPath,
    slot: input.slot,
    contributionId: input.contributionId,
    kind,
    title: input.title,
    tokens: { ...input.tokens },
    i18n: {
      zh: { ...(input.localePack?.zh ?? {}) },
      en: { ...(input.localePack?.en ?? {}) },
    },
  }
  if (input.size) data.size = { ...input.size }
  return data
}

/** 插槽 → 帧形态（用于客户端本地判断，不参与权限判定）。 */
export function slotKindOf(slot: SlotId): 'inline' | 'panel' | 'overlay' | 'modal' {
  switch (slot) {
    case 'dialog':
      return 'modal'
    case 'workspace.overlay':
    case 'play.overlay':
      return 'overlay'
    case 'workspace.topbar':
    case 'workspace.rail.footer':
    case 'command.palette':
      return 'inline'
    default:
      return 'panel'
  }
}

/* ------------------------------ 文档拼装 ------------------------------ */

function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * srcdoc 拼装（02 §4.2 的文档结构逐行实现；纯函数）。
 *
 * ```
 * <!doctype html><html ...><head>
 * <meta charset><meta CSP><meta referrer>
 * <style id="lumen-tokens"><style id="lumen-sdk"></head>
 * <body><div id="lumen-root"></div>
 * <script id="lumen-boot">window.__LUMEN_BOOT__=…; <bootstrap></script>
 * <script type="module" id="lumen-plugin" data-entry="plugin.js">…</script>
 * </body></html>
 * ```
 */
export function composeFrameDoc(input: FrameDocInput): string {
  const bootJson = escapeJsonForScript(composeBootData(input))
  const bootstrap = escapeScriptText(input.bootstrap)
  // 模块求值完成的**确定性哨兵**：插件源码顶层抛错时这条不会执行，bootstrap 在 load 时据此发 E-RUN-02
  // 而不是 __ready（02 §4.3 第 5 条；错误事件的派发时序不保证早于 load，所以不能只靠 error 事件）。
  const entry = escapeScriptText(input.entrySource + PLUGIN_EVALUATED_SENTINEL)
  const tokens = escapeStyleText(tokensCss(input.tokens))
  const sdk = escapeStyleText(LUMEN_SDK_CSS)
  const lang = input.lang === 'en' ? 'en' : 'zh-CN'
  const reduced = input.reducedMotion ? 'true' : 'false'
  return (
    '<!doctype html><html lang="' +
    lang +
    '" data-ui-theme="' +
    input.uiTheme +
    '" data-lang="' +
    (input.locale === 'en' ? 'en' : 'zh') +
    '" data-reduced-motion="' +
    reduced +
    '" data-density="' +
    input.density +
    '" data-plugin-id="' +
    escapeHtmlAttr(input.pluginId) +
    '" data-plugin-kind="' +
    input.pluginKind +
    '" data-plugin-slot="' +
    input.slot +
    '" data-frame-nonce="' +
    escapeHtmlAttr(input.frameNonce) +
    '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    escapeHtmlAttr(PLUGIN_CSP) +
    '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>' +
    escapeHtmlAttr(input.title) +
    '</title>' +
    '<style id="lumen-tokens">' +
    tokens +
    '</style>' +
    '<style id="lumen-sdk">' +
    sdk +
    '</style>' +
    '<style id="lumen-base">html,body{margin:0;padding:0;height:100%;overflow:auto;background:transparent;color-scheme:' +
    (input.uiTheme === 'light' ? 'light' : 'dark') +
    '}body{background:transparent}#lumen-root{min-height:100%;outline:none}</style>' +
    '</head><body><div id="lumen-root" data-sdk="v1" tabindex="0"></div>' +
    '<script id="lumen-boot">window.__LUMEN_BOOT__=' +
    bootJson +
    ';\n' +
    bootstrap +
    '</script>' +
    '<script type="module" id="lumen-plugin" data-entry="' +
    escapeHtmlAttr(input.entryPath) +
    '">' +
    entry +
    '</script>' +
    '</body></html>'
  )
}

/** 帧文档的基本自检（单测/宿主建帧前用；返回问题列表，空 = 通过）。 */
export function validateFrameDoc(html: string): string[] {
  const issues: string[] = []
  if (!html.startsWith('<!doctype html>')) issues.push('missing doctype')
  if (!html.includes(`content="${escapeHtmlAttr(PLUGIN_CSP)}"`)) issues.push('missing frozen PLUGIN_CSP')
  if (html.includes("'unsafe-eval'")) issues.push('unsafe-eval must not appear')
  if (!html.includes('id="lumen-root"')) issues.push('missing lumen-root')
  if (!html.includes('id="lumen-boot"')) issues.push('missing bootstrap script')
  if (!html.includes('type="module" id="lumen-plugin"')) issues.push('missing inline module script')
  if (/<script[^>]+src=/.test(html)) issues.push('external script src is not allowed')
  return issues
}
