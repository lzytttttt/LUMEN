#!/usr/bin/env node
/**
 * 生成 40 份插件契约夹具（20 合法 + 20 非法），qa-docs 拥有（task-8 / T-40-03）。
 *
 * 契约：plan/v0.4.0/02 §2.1–§2.6、§5.5、§6；06 §8（每份 ≤8KB、禁真实密钥/个人信息/外链 URL）。
 * 输出：
 *   tests/fixtures/plugins/valid/vNN-<slug>.lumenplug         → 20 份合法包
 *   tests/fixtures/plugins/invalid/iNN-<错误码>-<slug>.lumenplug → 20 份非法包（文件名带期望错误码）
 *
 * 设计要点：
 * - 本脚本自己实现 canonicalJson + sha256（与 02 §2.4 同口径），生成真实 integrity；
 *   契约测试会用插件运行时的 `verifyIntegrity()` 复核两份实现口径一致（防漂移）。
 * - createdAt 固定 2024-06-01T00:00:00Z，包内容全部确定，重复运行字节一致。
 * - 非法夹具尽量保证「能被 parseEnvelope 解析成功」，错误发生在期望的那一层
 *   （E-PKG-05/04/06/03/02/01 除外——它们本就发生在信封层）。
 *
 * 用法：node tests/fixtures/plugins/generate-fixtures.mjs
 * 注意：不要手工改生成物；改本脚本后重跑。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const validDir = join(here, 'valid')
const invalidDir = join(here, 'invalid')

/** 2024-06-01T00:00:00Z（02 §2.1：2020-01-01 ≤ t ≤ now+1d）。 */
const CREATED_AT = 1717200000000
const MAX_FIXTURE_BYTES = 8 * 1024

/* ------------------------------ canonical JSON（02 §2.4） ------------------------------ */

function canonicalJson(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return encodeString(value)
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonical json: non-finite number')
      if (Object.is(value, -0)) return '0'
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('canonical json: unsafe integer')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      break
    default:
      throw new Error(`canonical json: unsupported ${typeof value}`)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${encodeString(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function encodeString(value) {
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    const code = value.charCodeAt(i)
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `payload = { format, formatVersion, createdAt, manifest, files }`（02 §2.4 规则 6）。 */
function buildEnvelope(manifest, files) {
  const payload = { format: 'lumen-plugin', formatVersion: 1, createdAt: CREATED_AT, manifest, files }
  return { ...payload, integrity: `sha256:${sha256Hex(canonicalJson(payload))}` }
}

const ZERO_INTEGRITY = `sha256:${'0'.repeat(64)}`

/* ------------------------------ 素材 ------------------------------ */

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="var(--d-accent)"/></svg>'
const LIB_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" fill="none" stroke="var(--d-accent2)"/></svg>'
/** 极限边界夹具用超短素材源码（仍能过 sanitizeSvgDocument 与 viewBox 对拍）。 */
const TINY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'
// 入口源码必须通过 E-MAN-12 静态预检：注释里也不能出现禁用 API 词。
const CODE_JS = [
  '// QA fixture: minimal code plugin entry.',
  'const lumen = window.lumen',
  'lumen.meta.ready({ ok: true })',
  "lumen.ui.toast({ zh: '已加载', en: 'Loaded' })",
  '',
].join('\n')

const README = '# QA fixture\n\n仅用于 LUMEN 插件契约测试，无外部资源。\n'

const THEME_COLORS = {
  bg: '#0b0c10',
  fg: '#f2f4f8',
  muted: '#98a2b3',
  surface: '#141821',
  line: '#263041',
  accent: '#57e3c2',
  accent2: '#c8a15a',
}

function theme(id, overrides = {}) {
  return { id, name: { zh: `主题${id}`, en: `Theme ${id}` }, colors: THEME_COLORS, ...overrides }
}

function libItem(id, overrides = {}) {
  return {
    id,
    name: { zh: '形', en: 'G' },
    category: 'geometric',
    viewBox: [0, 0, 24, 24],
    source: TINY_SVG,
    ...overrides,
  }
}

function slugList(prefix, count, factory) {
  return Array.from({ length: count }, (_, i) => factory(`${prefix}${i + 1}`))
}

/* ------------------------------ manifest 基座 ------------------------------ */

let idSeq = 0
function manifest(overrides = {}) {
  idSeq += 1
  return {
    id: `com.qatools.fx${String(idSeq).padStart(2, '0')}`,
    name: { zh: '契约夹具', en: 'Contract Fixture' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'QA Fixtures' },
    description: { zh: '仅用于 LUMEN 插件契约测试的夹具包。', en: 'Fixture package for LUMEN plugin contract tests.' },
    license: 'MIT',
    capabilities: [],
    contributes: {},
    ...overrides,
  }
}

/* ------------------------------ 落盘 ------------------------------ */

function resetDir(dir) {
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true })
}

const written = []

function write(path, text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FIXTURE_BYTES) {
    throw new Error(`fixture ${relative(here, path)} is ${bytes} bytes (> ${MAX_FIXTURE_BYTES}); 06 §8 上限被打破`)
  }
  writeFileSync(path, text)
  written.push({ file: path, bytes })
}

function writeEnvelope(fileName, manifestObj, files, opts = {}) {
  const envelope = opts.envelope ?? buildEnvelope(manifestObj, files)
  const text = opts.compact ? JSON.stringify(envelope) : `${JSON.stringify(envelope, null, 2)}\n`
  write(join(opts.dir ?? validDir, fileName), text)
}

function writeInvalid(fileName, manifestObj, files, opts = {}) {
  writeEnvelope(fileName, manifestObj, files, { dir: invalidDir, ...opts })
}

/* =============================== 20 份合法夹具 =============================== */

resetDir(validDir)
idSeq = 0
const valid = []

function validCase(file, manifestObj, files, opts = {}) {
  writeEnvelope(file, manifestObj, files, opts)
  valid.push(file)
}

validCase(
  'v01-declarative-theme-min.lumenplug',
  manifest({
    version: '0.0.1',
    minAppVersion: '0.0.0',
    capabilities: ['theme:contribute'],
    contributes: { themes: [theme('mono')] },
  }),
  { 'readme.md': README },
)

validCase(
  'v02-declarative-theme-full.lumenplug',
  manifest({
    icon: 'icon.svg',
    capabilities: ['theme:contribute'],
    contributes: {
      themes: [
        theme('aurora-qa', {
          vibe: { zh: '冷静的极光', en: 'Calm aurora' },
          font: { body: 'system-ui, sans-serif', display: 'Georgia, serif', mono: 'ui-monospace, monospace' },
          typeScale: 1.05,
          radius: 12,
          motion: { ease: 'cubic-bezier(.32,.72,0,1)', ms: 380 },
          texture: { kind: 'grain', opacity: 0.12 },
          glow: 0.4,
          elevation: 'raised',
        }),
      ],
    },
  }),
  { 'readme.md': README, 'icon.svg': ICON_SVG },
)

validCase(
  'v03-declarative-theme-max6.lumenplug',
  manifest({ capabilities: ['theme:contribute'], contributes: { themes: slugList('mix', 6, (id) => theme(id)) } }),
  { 'readme.md': README },
)

validCase(
  'v04-declarative-library.lumenplug',
  manifest({ capabilities: ['library:contribute'], contributes: { library: [libItem('mark')] } }),
  { 'readme.md': README, 'assets/mark.svg': LIB_SVG },
)

validCase(
  'v05-declarative-library-max32.lumenplug',
  manifest({
    capabilities: ['library:contribute'],
    contributes: { library: slugList('shape', 32, (id) => libItem(id)) },
  }),
  { 'readme.md': README },
  { compact: true },
)

validCase(
  'v06-declarative-i18n.lumenplug',
  manifest({
    capabilities: ['i18n:contribute'],
    contributes: {
      i18n: [{ zh: { hello: '你好', title: '标题', hint: '提示' }, en: { hello: 'Hello', title: 'Title', hint: 'Hint' } }],
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v07-declarative-settings-all-fields.lumenplug',
  manifest({
    capabilities: ['storage'],
    contributes: {
      settings: {
        id: 'prefs',
        title: { zh: '偏好设置', en: 'Preferences' },
        fields: [
          { key: 'label', type: 'text', label: { zh: '标签', en: 'Label' }, placeholder: 'A', maxLength: 40 },
          { key: 'note', type: 'textarea', label: { zh: '备注', en: 'Note' }, maxLength: 400 },
          { key: 'enabled', type: 'switch', label: { zh: '启用', en: 'Enabled' }, default: true },
          { key: 'count', type: 'number', label: { zh: '数量', en: 'Count' }, min: 0, max: 99, step: 1, default: 3 },
          { key: 'level', type: 'slider', label: { zh: '强度', en: 'Level' }, min: 0, max: 100, step: 5, default: 50 },
          {
            key: 'mode',
            type: 'select',
            label: { zh: '模式', en: 'Mode' },
            options: [
              { value: 'a', label: { zh: '甲', en: 'A' } },
              { value: 'b', label: { zh: '乙', en: 'B' } },
            ],
          },
        ],
      },
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v08-declarative-commands-7-actions.lumenplug',
  manifest({
    capabilities: ['ui:command', 'theme:contribute', 'ui:layout', 'deck:write', 'library:contribute', 'export:hook'],
    contributes: {
      themes: [theme('cmd')],
      library: [libItem('cmdmark')],
      layoutPresets: [{ id: 'cmdlayout', name: { zh: '命令布局', en: 'Command layout' }, apply: { dockHeight: 260 } }],
      // 注：openPluginPanel 对 declarative 不可达（契约缺口已报 plugin-core），夹具用其余 7 项。
      commands: [
        { id: 'apply-theme', title: { zh: '应用主题', en: 'Apply theme' }, category: 'plugin', action: { kind: 'setTheme', themeId: 'cmd' } },
        {
          id: 'apply-layout',
          title: { zh: '应用布局', en: 'Apply layout' },
          category: 'plugin',
          action: { kind: 'applyLayoutPreset', presetId: 'cmdlayout' },
        },
        {
          id: 'insert-mark',
          title: { zh: '插入素材', en: 'Insert mark' },
          category: 'plugin',
          action: { kind: 'insertLibrarySvg', libraryId: 'cmdmark' },
        },
        {
          id: 'insert-text',
          title: { zh: '插入文本', en: 'Insert text' },
          category: 'plugin',
          action: { kind: 'insertTextBlocks', blocks: [{ text: 'QA', variant: 'h2', x: 80, y: 120, w: 400, h: 80 }] },
        },
        { id: 'open-prefs', title: { zh: '打开设置', en: 'Open settings' }, category: 'plugin', action: { kind: 'openSettings' } },
        { id: 'preflight', title: { zh: '导出预检', en: 'Preflight' }, category: 'plugin', action: { kind: 'runExportPreflight' } },
        {
          id: 'say-hi',
          title: { zh: '打个招呼', en: 'Say hi' },
          category: 'plugin',
          action: { kind: 'toast', message: { zh: '你好', en: 'Hello' } },
        },
      ],
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v09-declarative-keymap.lumenplug',
  manifest({
    capabilities: ['ui:command', 'ui:keymap'],
    contributes: {
      commands: [
        {
          id: 'say-hi',
          title: { zh: '打个招呼', en: 'Say hi' },
          category: 'plugin',
          action: { kind: 'toast', message: { zh: '你好', en: 'Hello' } },
        },
      ],
      keymap: [{ combo: 'mod+shift+j', commandId: 'say-hi' }],
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v10-declarative-layout-boundary.lumenplug',
  manifest({
    capabilities: ['ui:layout'],
    contributes: {
      layoutPresets: [
        {
          id: 'focus-layout',
          name: { zh: '专注布局', en: 'Focus layout' },
          apply: {
            railWidth: 180,
            panelWidth: 420,
            dockHeight: 240,
            hideRail: false,
            hideInspector: false,
            leftTab: 'outline',
            rightMode: 'composer',
            inspectorTab: 'props',
            showGrid: true,
            density: 'compact',
          },
        },
      ],
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v11-declarative-multi-7kinds.lumenplug',
  manifest({
    capabilities: ['theme:contribute', 'library:contribute', 'i18n:contribute', 'storage', 'ui:command', 'ui:keymap', 'ui:layout'],
    contributes: {
      themes: [theme('multi')],
      library: [libItem('multimark')],
      i18n: [{ zh: { hello: '你好' }, en: { hello: 'Hello' } }],
      settings: {
        id: 'prefs',
        title: { zh: '偏好', en: 'Preferences' },
        fields: [{ key: 'enabled', type: 'switch', label: { zh: '启用', en: 'Enabled' }, default: true }],
      },
      commands: [
        {
          id: 'apply-theme',
          title: { zh: '应用主题', en: 'Apply theme' },
          category: 'plugin',
          action: { kind: 'setTheme', themeId: 'multi' },
        },
      ],
      keymap: [{ combo: 'mod+alt+m', commandId: 'apply-theme' }],
      layoutPresets: [{ id: 'multi-layout', name: { zh: '多贡献布局', en: 'Multi layout' }, apply: { density: 'compact' } }],
    },
  }),
  { 'readme.md': README },
)

validCase(
  'v12-code-min.lumenplug',
  manifest({ kind: 'code', entry: 'plugin.js', capabilities: [], contributes: {} }),
  { 'plugin.js': CODE_JS },
)

validCase(
  'v13-code-slot-dock.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['ui:slot'],
    contributes: {
      slots: [
        {
          id: 'qa-dock',
          slot: 'workspace.dock',
          title: { zh: 'QA 看板', en: 'QA board' },
          kind: 'panel',
          size: { w: 960, h: 260 },
          order: 10,
        },
      ],
    },
  }),
  { 'plugin.js': CODE_JS, 'icon.svg': ICON_SVG },
)

validCase(
  'v14-code-slot-inline-open.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    icon: 'icon.svg',
    capabilities: ['ui:slot'],
    contributes: {
      slots: [
        {
          id: 'qa-entry',
          slot: 'workspace.topbar',
          title: { zh: 'QA', en: 'QA' },
          icon: 'icon.svg',
          kind: 'inline',
          open: { slot: 'dialog', contributionId: 'qa-about' },
        },
        { id: 'qa-about', slot: 'dialog', title: { zh: '关于 QA', en: 'About QA' }, kind: 'modal' },
      ],
    },
  }),
  { 'plugin.js': CODE_JS, 'icon.svg': ICON_SVG },
)

validCase(
  'v15-code-slot-play-overlay.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['ui:slot'],
    contributes: {
      slots: [{ id: 'qa-timer', slot: 'play.overlay', title: { zh: '排练计时', en: 'Rehearsal timer' }, kind: 'overlay', order: 5 }],
    },
  }),
  { 'plugin.js': CODE_JS },
)

validCase(
  'v16-code-lint-max8.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['lint:rule'],
    contributes: {
      lintRules: slugList('rule', 8, (id) => ({
        id,
        title: { zh: `规则${id}`, en: `Rule ${id}` },
        severity: 'warn',
        description: { zh: '夹具规则', en: 'Fixture rule' },
      })),
    },
  }),
  { 'plugin.js': CODE_JS },
)

validCase(
  'v17-code-recipes-max6.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['ai:recipe'],
    contributes: {
      recipes: slugList('recipe', 6, (id) => ({
        id,
        namespace: 'qafix',
        title: { zh: `配方${id}`, en: `Recipe ${id}` },
        slots: [{ key: 'headline', required: true }, { key: 'points', max: 3 }, { key: 'visual' }],
        preview: 'assets/preview.svg',
      })),
    },
  }),
  { 'plugin.js': CODE_JS, 'assets/preview.svg': LIB_SVG },
)

validCase(
  'v18-code-export-hooks-max2.lumenplug',
  manifest({
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['export:hook'],
    contributes: {
      exportHooks: [
        { id: 'preflight', title: { zh: '导出预检', en: 'Export preflight' }, kind: 'preflight' },
        { id: 'assets', title: { zh: '导出资产', en: 'Export assets' }, kind: 'assets', maxBytes: 1048576 },
      ],
    },
  }),
  { 'plugin.js': CODE_JS },
)

// v19：长度边界（id 96 字符 / name 24 / description 160 / author 64 / license 64 / semver 预发布 32）
{
  const idSegments = ['abcdefghijklmnopqrst', 'abcdefghijklmnopqr', 'abcdefghijklmnopqr', 'abcdefghijklmnopqr', 'abcdefghijklmnopqr']
  const longId = idSegments.join('.')
  if (longId.length !== 96) throw new Error(`boundary id length ${longId.length} != 96`)
  const name24 = 'n'.repeat(24)
  const desc160 = 'd'.repeat(160)
  validCase(
    'v19-boundary-lengths.lumenplug',
    manifest({
      id: longId,
      name: { zh: name24, en: name24 },
      version: '12345.12345.12345-abcdefghijklmnopqrstuvwxyz012345',
      minAppVersion: '0.4.0',
      author: { name: 'a'.repeat(64) },
      license: 'L'.repeat(64),
      description: { zh: desc160, en: desc160 },
      capabilities: ['i18n:contribute'],
      contributes: { i18n: [{ zh: { k: '值' }, en: { k: 'Value' } }] },
    }),
    { 'readme.md': README },
  )
}

// v20：文件数上限 64 + 逼近夹具 8KB 上限（覆盖「最大体积内 / 最多文件数」两个边界）
{
  const files = { 'readme.md': README }
  for (let i = 1; i <= 63; i += 1) {
    files[`assets/f${String(i).padStart(2, '0')}.txt`] = `${'x'.repeat(72)}-${i}`
  }
  if (Object.keys(files).length !== 64) throw new Error('v20 file count != 64')
  validCase(
    'v20-boundary-max-files.lumenplug',
    manifest({ capabilities: ['i18n:contribute'], contributes: { i18n: [{ zh: { k: '值' }, en: { k: 'Value' } }] } }),
    files,
    { compact: true },
  )
}

/* =============================== 20 份非法夹具 =============================== */

resetDir(invalidDir)
idSeq = 0
const invalid = []

function invalidCase(file, manifestObj, files, opts = {}) {
  writeInvalid(file, manifestObj, files, opts)
  invalid.push(file)
}

const declarativeOk = (overrides = {}) =>
  manifest({
    capabilities: ['i18n:contribute'],
    contributes: { i18n: [{ zh: { k: '值' }, en: { k: 'Value' } }] },
    ...overrides,
  })

/** 信封层：这些构造不保证 integrity 有效（错误发生在 integrity 校验之前）。 */
function writeRawInvalid(fileName, envelopeLike) {
  write(join(invalidDir, fileName), `${JSON.stringify(envelopeLike, null, 2)}\n`)
  invalid.push(fileName)
}

// i01 E-PKG-01：坏 JSON（截断）
{
  const good = JSON.stringify(buildEnvelope(declarativeOk(), { 'readme.md': README }), null, 2)
  write(join(invalidDir, 'i01-E-PKG-01-bad-json.lumenplug'), `${good.slice(0, Math.floor(good.length / 2))}\n`)
  invalid.push('i01-E-PKG-01-bad-json.lumenplug')
}

// i02 E-PKG-01：信封未知字段
{
  const env = buildEnvelope(declarativeOk(), { 'readme.md': README })
  writeRawInvalid('i02-E-PKG-01-unknown-envelope-field.lumenplug', { ...env, signature: 'deadbeef' })
}

// i03 E-PKG-02：format 非法
{
  const env = buildEnvelope(declarativeOk(), { 'readme.md': README })
  writeRawInvalid('i03-E-PKG-02-bad-format.lumenplug', { ...env, format: 'lumen-plugin-v2' })
}

// i04 E-PKG-02：formatVersion = 2
{
  const env = buildEnvelope(declarativeOk(), { 'readme.md': README })
  writeRawInvalid('i04-E-PKG-02-format-version-2.lumenplug', { ...env, formatVersion: 2 })
}

// i05 E-PKG-03：缺 files
{
  const env = buildEnvelope(declarativeOk(), { 'readme.md': README })
  const { files: _files, ...rest } = env
  writeRawInvalid('i05-E-PKG-03-missing-files.lumenplug', { ...rest, integrity: ZERO_INTEGRITY })
}

// i06 E-PKG-04：文件数 65 > 64
{
  const files = {}
  for (let i = 1; i <= 65; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = 'x'
  invalidCase('i06-E-PKG-04-too-many-files.lumenplug', declarativeOk(), files)
}

// i07 E-PKG-05：integrity 不匹配
{
  const env = buildEnvelope(declarativeOk(), { 'readme.md': README })
  invalidCase('i07-E-PKG-05-integrity-mismatch.lumenplug', env.manifest, env.files, {
    envelope: { ...env, integrity: ZERO_INTEGRITY },
  })
}

// i08 E-PKG-06：路径穿越
invalidCase('i08-E-PKG-06-path-traversal.lumenplug', declarativeOk(), { '../evil.js': 'x', 'readme.md': README })

// i09 E-PKG-06：非法扩展名
invalidCase('i09-E-PKG-06-bad-extension.lumenplug', declarativeOk(), { 'plugin.exe': 'x', 'readme.md': README })

// i10 E-MAN-01：manifest 缺 name
{
  const m = declarativeOk()
  delete m.name
  invalidCase('i10-E-MAN-01-manifest-missing-name.lumenplug', m, { 'readme.md': README })
}

// i11 E-MAN-01：manifest 未知字段（.strict() 拒绝）
invalidCase(
  'i11-E-MAN-01-unknown-manifest-field.lumenplug',
  { ...declarativeOk(), homepage: 'https://example.com' },
  { 'readme.md': README },
)

// i12 E-MAN-02：保留命名空间（com.lumen.*）
invalidCase('i12-E-MAN-02-id-reserved-prefix.lumenplug', declarativeOk({ id: 'com.lumen.evil' }), { 'readme.md': README })

// i13 E-MAN-03：version 非 semver
invalidCase('i13-E-MAN-03-version-bad-semver.lumenplug', declarativeOk({ version: '1.0' }), { 'readme.md': README })

// i14 E-MAN-04：apiVersion 2.0
invalidCase('i14-E-MAN-04-api-version-2.lumenplug', declarativeOk({ apiVersion: '2.0' }), { 'readme.md': README })

// i15 E-MAN-05：minAppVersion 过高
invalidCase('i15-E-MAN-05-min-app-too-high.lumenplug', declarativeOk({ minAppVersion: '99.0.0' }), { 'readme.md': README })

// i16 E-MAN-06：code 插件缺 entry
invalidCase('i16-E-MAN-06-code-missing-entry.lumenplug', declarativeOk({ kind: 'code' }), { 'plugin.js': CODE_JS })

// i17 E-MAN-07：declarative 声明 entry
invalidCase('i17-E-MAN-07-declarative-with-entry.lumenplug', declarativeOk({ entry: 'plugin.js' }), {
  'plugin.js': CODE_JS,
})

// i18 E-MAN-08：能力非法
invalidCase('i18-E-MAN-08-capability-invalid.lumenplug', declarativeOk({ capabilities: ['deck:destroy'] }), {
  'readme.md': README,
})

// i19 E-MAN-09：贡献超限（themes 7 > 6）
invalidCase(
  'i19-E-MAN-09-themes-over-limit.lumenplug',
  declarativeOk({ capabilities: ['theme:contribute'], contributes: { themes: slugList('over', 7, (id) => theme(id)) } }),
  { 'readme.md': README },
)

// i20 E-MAN-11：icon 非 svg
invalidCase(
  'i20-E-MAN-11-icon-not-svg.lumenplug',
  declarativeOk({ kind: 'code', entry: 'plugin.js', icon: 'assets/icon.png', capabilities: [], contributes: {} }),
  { 'plugin.js': CODE_JS },
)

/* ------------------------------ 汇总与自检 ------------------------------ */

if (valid.length !== 20 || invalid.length !== 20) {
  throw new Error(`expected 20 valid + 20 invalid, got ${valid.length} + ${invalid.length}`)
}
const all = written.map((row) => ({ file: relative(here, row.file), bytes: row.bytes }))
const sorted = [...all].sort((a, b) => b.bytes - a.bytes)
console.log(
  `generated ${all.length} fixtures, max ${sorted[0].bytes} B (${sorted[0].file}), total ${all.reduce((s, r) => s + r.bytes, 0)} B`,
)
for (const row of sorted.slice(0, 5)) console.log(`  ${String(row.bytes).padStart(5)} B  ${row.file}`)
if (sorted[0].bytes > MAX_FIXTURE_BYTES) process.exit(1)
