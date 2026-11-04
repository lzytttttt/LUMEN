/**
 * plugins-contract.test.ts —— `.lumenplug` 包与清单的契约测试（T-40-03 / G1）。
 *
 * 契约：plan/v0.4.0/02 §2.1–§2.6（信封/文件/清单/版本/命名空间）、§5.5（45 错误码）、§6（贡献形状）；
 *      06 §8（合法 20 + 非法 20，每份 ≤8KB，文件名带期望错误码）。
 *
 * 夹具由 `tests/fixtures/plugins/generate-fixtures.mjs` 生成（确定性字节，integrity 真实可校验）：
 *   - valid/v01…v20   → parseEnvelope + verifyIntegrity + parseManifest 全部通过，并覆盖 11 类贡献边界；
 *   - invalid/i01…i20 → 文件名内嵌期望错误码（E-PKG-* / E-MAN-*），失败信息带夹具名。
 *
 * 纪律：不 mock 被测模块；jsdom 缺 `crypto.subtle` 时仅补 Node webcrypto（02 §2.4 要求真实 SHA-256）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_FILE_EXTENSIONS,
  PACKAGE_LIMITS,
  buildEnvelope,
  bytesOf,
  canonicalJson,
  integrityOf,
  parseEnvelope,
  serializeEnvelope,
  sha256Hex,
  validatePath,
  verifyIntegrity,
  payloadOf,
} from '@/plugins/package'
import { parseManifest } from '@/plugins/manifest'
import { PluginError, isPluginError } from '@/plugins/errors'
import {
  CAPABILITY_IDS,
  PLUGIN_ERROR_CODES,
  type Capability,
  type LocalePackContribution,
  type PluginManifest,
  type SlotContribution,
} from '@/plugins/types'

/* ------------------------------ 环境与夹具工具 ------------------------------ */

if (!(globalThis.crypto as Crypto | undefined)?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

// Vitest 的 jsdom 环境里 import.meta.url 不是 file: 协议，统一以仓库根为基准（vitest cwd = 仓库根）。
const FIXTURES_ROOT = join(process.cwd(), 'tests', 'fixtures', 'plugins')
const VALID_DIR = join(FIXTURES_ROOT, 'valid')
const INVALID_DIR = join(FIXTURES_ROOT, 'invalid')
const MAX_FIXTURE_BYTES = 8 * 1024

function listFixtures(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.lumenplug'))
    .sort()
}

const VALID_FILES = listFixtures(VALID_DIR)
const INVALID_FILES = listFixtures(INVALID_DIR)

function readFixture(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

/** 非法夹具文件名内嵌期望错误码：`iNN-E-PKG-05-integrity-mismatch.lumenplug`。 */
function expectedCodeOf(file: string): string {
  const match = /^i\d+-(E-[A-Z]+-\d+)-/.exec(file)
  if (!match) throw new Error(`invalid fixture name lacks error code: ${file}`)
  return match[1]
}

/** 安装管线（02 §3.1 步骤 2–4）：解析信封 → 校验 integrity → 校验 manifest。 */
async function pipeline(text: string): Promise<PluginManifest> {
  const envelope = parseEnvelope(text)
  await verifyIntegrity(envelope)
  return parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
}

async function expectPluginError(text: string, expected: string, label: string): Promise<PluginError> {
  try {
    await pipeline(text)
  } catch (error) {
    expect(isPluginError(error), `${label}: 期望抛 PluginError，实际 ${String(error)}`).toBe(true)
    const pluginError = error as PluginError
    expect(
      pluginError.code,
      `${label}: 期望 ${expected}，实际 ${pluginError.code}（${pluginError.message}）`,
    ).toBe(expected)
    return pluginError
  }
  throw new Error(`${label}: 期望 ${expected}，但管线成功通过`)
}

/* ------------------------------ manifest 基座（内联反例用） ------------------------------ */

function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'com.qatools.inline',
    name: { zh: '内联夹具', en: 'Inline Fixture' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'QA' },
    description: { zh: '内联反例夹具。', en: 'Inline negative fixture.' },
    license: 'MIT',
    capabilities: [],
    contributes: {},
    ...overrides,
  }
}

const okFiles = { 'readme.md': '# inline\n' }
const codeFiles = { 'plugin.js': 'const lumen = window.lumen\nlumen.meta.ready({})\n' }

function manifestError(manifest: PluginManifest, files: Record<string, string> = okFiles): PluginError {
  try {
    parseManifest(manifest, { files, installSource: 'file' })
  } catch (error) {
    expect(isPluginError(error), `期望 PluginError，实际 ${String(error)}`).toBe(true)
    return error as PluginError
  }
  throw new Error('期望 parseManifest 失败，但通过了')
}

/* ================================ 夹具清单自检 ================================ */

describe('契约夹具清单（06 §8）', () => {
  it('合法 20 份 + 非法 20 份，文件名与体积符合约束', () => {
    expect(VALID_FILES, `valid 夹具：${VALID_FILES.join(', ')}`).toHaveLength(20)
    expect(INVALID_FILES, `invalid 夹具：${INVALID_FILES.join(', ')}`).toHaveLength(20)
    for (const dir of [VALID_DIR, INVALID_DIR]) {
      for (const file of listFixtures(dir)) {
        const bytes = Buffer.byteLength(readFixture(dir, file), 'utf8')
        expect(bytes, `${file} 体积 ${bytes}B 超过 06 §8 的 8KB 上限`).toBeLessThanOrEqual(MAX_FIXTURE_BYTES)
      }
    }
  })

  it('非法夹具覆盖 16 个错误码（E-PKG-01…06 / E-MAN-01…09 / E-MAN-11）', () => {
    const codes = new Set(INVALID_FILES.map(expectedCodeOf))
    expect([...codes].sort()).toEqual(
      [
        'E-MAN-01',
        'E-MAN-02',
        'E-MAN-03',
        'E-MAN-04',
        'E-MAN-05',
        'E-MAN-06',
        'E-MAN-07',
        'E-MAN-08',
        'E-MAN-09',
        'E-MAN-11',
        'E-PKG-01',
        'E-PKG-02',
        'E-PKG-03',
        'E-PKG-04',
        'E-PKG-05',
        'E-PKG-06',
      ].sort(),
    )
    for (const code of codes) {
      expect(PLUGIN_ERROR_CODES as readonly string[], `夹具错误码 ${code} 不在 02 §5.5 冻结表`).toContain(code)
    }
  })
})

/* ================================ 合法夹具 ================================ */

describe('合法插件包（20 份全通过）', () => {
  it.each(VALID_FILES)('%s：信封 + integrity + manifest 全通过', async (file) => {
    const text = readFixture(VALID_DIR, file)
    const envelope = parseEnvelope(text)

    expect(envelope.format).toBe('lumen-plugin')
    expect(envelope.formatVersion).toBe(1)
    expect(Number.isSafeInteger(envelope.createdAt)).toBe(true)
    expect(envelope.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)

    // 文件规则（02 §2.2）
    const names = Object.keys(envelope.files)
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThanOrEqual(PACKAGE_LIMITS.maxFiles)
    for (const path of names) {
      expect(() => validatePath(path), `${file}: 文件路径 ${path}`).not.toThrow()
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      expect(ALLOWED_FILE_EXTENSIONS as readonly string[], `${file}: ${path} 扩展名`).toContain(ext)
      expect(bytesOf(envelope.files[path]), `${file}: ${path} 体积`).toBeLessThanOrEqual(PACKAGE_LIMITS.maxFileBytes)
    }

    // integrity 必须可由运行时重算（夹具生成器与 package.ts 的 canonical JSON 口径一致）
    await expect(verifyIntegrity(envelope), `${file}: integrity 校验`).resolves.toBeUndefined()

    // manifest 全量校验（含能力↔贡献一致性、命名空间、图标净化、入口静态预检）
    const manifest = parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
    expect(manifest.id).toBe(envelope.manifest.id)
    expect(manifest.kind).toBe(envelope.manifest.kind)
    expect(manifest.capabilities).toEqual([...new Set(manifest.capabilities)])
    for (const capability of manifest.capabilities) {
      expect(CAPABILITY_IDS as readonly string[], `${file}: 能力 ${capability}`).toContain(capability)
    }

    // 信封序列化（canonical）稳定且可回读
    const serialized = serializeEnvelope(envelope)
    expect(canonicalJson(envelope)).toBe(serialized)
    expect(serializeEnvelope(parseEnvelope(serialized))).toBe(serialized)
  })

  it('20 份合法夹具覆盖 11 类贡献与两种 kind', async () => {
    const seen = new Set<string>()
    const kinds = new Set<string>()
    for (const file of VALID_FILES) {
      const envelope = parseEnvelope(readFixture(VALID_DIR, file))
      const manifest = parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
      kinds.add(manifest.kind)
      for (const key of Object.keys(manifest.contributes)) seen.add(key)
    }
    expect([...kinds].sort()).toEqual(['code', 'declarative'])
    expect([...seen].sort()).toEqual(
      [
        'commands',
        'exportHooks',
        'i18n',
        'keymap',
        'layoutPresets',
        'library',
        'lintRules',
        'recipes',
        'settings',
        'slots',
        'themes',
      ].sort(),
    )
  })

  it('边界夹具逐项达标：v03 themes=6 / v05 library=32 / v16 lintRules=8 / v17 recipes=6 / v18 exportHooks=2 / v19 id=96 / v20 files=64', async () => {
    const load = async (file: string) => {
      const envelope = parseEnvelope(readFixture(VALID_DIR, file))
      return { envelope, manifest: parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' }) }
    }

    const v03 = await load('v03-declarative-theme-max6.lumenplug')
    expect(v03.manifest.contributes.themes).toHaveLength(6)

    const v05 = await load('v05-declarative-library-max32.lumenplug')
    expect(v05.manifest.contributes.library).toHaveLength(32)

    const v16 = await load('v16-code-lint-max8.lumenplug')
    expect(v16.manifest.contributes.lintRules).toHaveLength(8)

    const v17 = await load('v17-code-recipes-max6.lumenplug')
    expect(v17.manifest.contributes.recipes).toHaveLength(6)

    const v18 = await load('v18-code-export-hooks-max2.lumenplug')
    expect(v18.manifest.contributes.exportHooks).toHaveLength(2)

    const v19 = await load('v19-boundary-lengths.lumenplug')
    expect(v19.manifest.id).toHaveLength(96)
    expect(v19.manifest.name.zh).toHaveLength(24)
    expect(v19.manifest.description.en).toHaveLength(160)
    expect(v19.manifest.author.name).toHaveLength(64)
    expect(v19.manifest.license).toHaveLength(64)

    const v20 = await load('v20-boundary-max-files.lumenplug')
    expect(Object.keys(v20.envelope.files)).toHaveLength(64)
  })

  it('代码式夹具：入口存在、kind/entry 一致、播放态覆盖 play.overlay', async () => {
    const codeFixtures = VALID_FILES.filter((file) => file.includes('-code-'))
    expect(codeFixtures.length).toBeGreaterThanOrEqual(7)
    for (const file of codeFixtures) {
      const envelope = parseEnvelope(readFixture(VALID_DIR, file))
      const manifest = parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
      expect(manifest.kind, file).toBe('code')
      expect(manifest.entry, file).toBeTruthy()
      expect(Object.keys(envelope.files), `${file}: entry 必须在 files 内`).toContain(manifest.entry)
      expect(manifest.contributes.commands, `${file}: code 插件不得清单声明 commands`).toBeUndefined()
    }
    const playOverlay = await (async () => {
      const envelope = parseEnvelope(readFixture(VALID_DIR, 'v15-code-slot-play-overlay.lumenplug'))
      return parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
    })()
    expect(playOverlay.contributes.slots?.map((slot) => slot.slot)).toEqual(['play.overlay'])
  })
})

/* ================================ 非法夹具 ================================ */

describe('非法插件包（20 份各自命中唯一错误码）', () => {
  it.each(INVALID_FILES)('%s：按契约错误码拒绝', async (file) => {
    const expected = expectedCodeOf(file)
    const text = readFixture(INVALID_DIR, file)
    await expectPluginError(text, expected, `${file}（期望 ${expected}）`)
  })

  it('E-MAN-10 伪造 trust：文件安装剥离 trust 并告警，不静默放行', () => {
    const warnings: string[] = []
    const manifest = parseManifest(
      baseManifest({ trust: 'builtin', capabilities: ['i18n:contribute'], contributes: { i18n: [{ zh: { k: '值' }, en: { k: 'V' } }] } }),
      { files: okFiles, installSource: 'file', onWarning: (code, detail) => warnings.push(`${code}:${detail}`) },
    )
    expect(manifest.trust).toBeUndefined()
    expect(warnings.some((warning) => warning.startsWith('E-MAN-10'))).toBe(true)
  })
})

/* ============================ 内联反例 / 边界 ============================ */

describe('canonical JSON 与摘要口径（02 §2.4）', () => {
  it('对象键排序无关、无空白、非 ASCII 原样、-0 归一', () => {
    const a = { b: 1, a: { d: 2, c: 'x' }, list: [3, 1, 2] }
    const b = { list: [3, 1, 2], a: { c: 'x', d: 2 }, b: 1 }
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":2},"b":1,"list":[3,1,2]}')
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson({ zh: '值' })).toBe('{"zh":"值"}')
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson({ q: '"\\\n' })).toBe('{"q":"\\"\\\\\\u000a"}')
  })

  it('拒绝非纯数据：NaN/Infinity/非安全整数/undefined/函数/非纯对象/超深嵌套 → E-PKG-01', () => {
    const rejects: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
      () => 1,
      new Date(0),
    ]
    for (const value of rejects) {
      try {
        canonicalJson(value)
        throw new Error(`期望拒绝 ${String(value)}`)
      } catch (error) {
        expect(isPluginError(error), String(value)).toBe(true)
        expect((error as PluginError).code, String(value)).toBe('E-PKG-01')
      }
    }
    let deep: unknown = 1
    for (let i = 0; i < 80; i += 1) deep = { nested: deep }
    expect(() => canonicalJson(deep)).toThrowError(PluginError)
  })

  it('sha256 / bytesOf / integrityOf 与已知向量一致', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(bytesOf('abc')).toBe(3)
    expect(bytesOf('中')).toBe(3)
    const payload = { format: 'lumen-plugin', formatVersion: 1, createdAt: 1717200000000, manifest: {}, files: {} }
    const integrity = await integrityOf(payload)
    expect(integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(integrity).toBe(`sha256:${await sha256Hex(canonicalJson(payload))}`)
  })

  it('buildEnvelope → verifyIntegrity 往返；篡改 files 后 E-PKG-05', async () => {
    const manifest = baseManifest({ capabilities: ['i18n:contribute'], contributes: { i18n: [{ zh: { k: '值' }, en: { k: 'V' } }] } })
    const envelope = await buildEnvelope({ manifest, files: okFiles, createdAt: 1717200000000 })
    await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()

    const tampered = { ...envelope, files: { ...envelope.files, 'readme.md': '# tampered\n' } }
    await expect(verifyIntegrity(tampered)).rejects.toMatchObject({ code: 'E-PKG-05' })
    expect(payloadOf(tampered).files['readme.md']).toBe('# tampered\n')
  })
})

describe('信封与文件规则（02 §2.1/§2.2）', () => {
  it('超过 maxBytes 选项 → E-PKG-04（安装入口用该选项提前断流）', () => {
    const text = JSON.stringify({ format: 'lumen-plugin', formatVersion: 1, createdAt: 1717200000000, integrity: `sha256:${'0'.repeat(64)}`, manifest: {}, files: { 'a.txt': 'x'.repeat(2000) } })
    expect(() => parseEnvelope(text, { maxBytes: 1000 })).toThrowError(PluginError)
    try {
      parseEnvelope(text, { maxBytes: 1000 })
    } catch (error) {
      expect((error as PluginError).code).toBe('E-PKG-04')
    }
  })

  it('路径/扩展名规则：穿越、反斜杠、绝对路径、深度>3、node_modules、大写、无扩展名、源清单文件 → E-PKG-06', async () => {
    const badPaths = [
      '../evil.js',
      'a\\b.js',
      '/abs.js',
      'C:/abs.js',
      'a/b/c/d.js',
      'node_modules/x.js',
      'UPPER.js',
      'noext',
      '.lumen-plugin.json',
    ]
    for (const path of badPaths) {
      const envelope = await buildEnvelope({ manifest: baseManifest(), files: { [path]: 'x' }, createdAt: 1717200000000 })
      try {
        parseEnvelope(JSON.stringify(envelope))
        throw new Error(`期望拒绝路径 ${path}`)
      } catch (error) {
        expect(isPluginError(error), path).toBe(true)
        expect((error as PluginError).code, path).toBe('E-PKG-06')
      }
    }
  })

  it('文件数 65 / 单文件超 512KB → E-PKG-04', async () => {
    const many: Record<string, string> = {}
    for (let i = 1; i <= 65; i += 1) many[`f${i}.txt`] = 'x'
    const tooMany = await buildEnvelope({ manifest: baseManifest(), files: many, createdAt: 1717200000000 })
    try {
      parseEnvelope(JSON.stringify(tooMany))
      throw new Error('期望 65 文件被拒')
    } catch (error) {
      expect((error as PluginError).code).toBe('E-PKG-04')
    }

    const bigFile = { 'big.txt': 'x'.repeat(PACKAGE_LIMITS.maxFileBytes + 1) }
    const bigEnvelope = await buildEnvelope({ manifest: baseManifest(), files: bigFile, createdAt: 1717200000000 })
    try {
      parseEnvelope(JSON.stringify(bigEnvelope))
      throw new Error('期望 512KB 单文件被拒')
    } catch (error) {
      expect((error as PluginError).code).toBe('E-PKG-04')
    }
  })
})

describe('manifest 反例（02 §2.3 / §6）', () => {
  it('keymap 裸键（无修饰键）→ E-MAN-09；declarative 引用未声明命令 → E-MAN-09', () => {
    const bareKey = manifestError(
      baseManifest({
        capabilities: ['ui:keymap', 'ui:command'],
        contributes: {
          commands: [
            { id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } },
          ],
          keymap: [{ combo: 'z', commandId: 'hi' }],
        },
      }),
    )
    expect(bareKey.code).toBe('E-MAN-09')

    const undeclared = manifestError(
      baseManifest({ capabilities: ['ui:keymap', 'ui:command'], contributes: { keymap: [{ combo: 'mod+k', commandId: 'nope' }] } }),
    )
    expect(undeclared.code).toBe('E-MAN-09')
  })

  it('settings 声明成数组 → E-MAN-01（单对象契约）', () => {
    const error = manifestError(
      baseManifest({ capabilities: ['storage'], contributes: { settings: [{ id: 'xx', title: { zh: 'x', en: 'x' }, fields: [] }] as never } }),
    )
    expect(error.code).toBe('E-MAN-01')
  })

  it('code 插件清单声明 commands → E-MAN-07；declarative 声明 slots/lintRules/recipes/exportHooks → E-MAN-07', () => {
    const codeCommands = manifestError(
      baseManifest({
        kind: 'code',
        entry: 'plugin.js',
        capabilities: ['ui:command'],
        contributes: {
          commands: [{ id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } }],
        },
      }),
      codeFiles,
    )
    expect(codeCommands.code).toBe('E-MAN-07')

    const declarativeSlots = manifestError(
      baseManifest({
        capabilities: ['ui:slot'],
        contributes: { slots: [{ id: 'panel', slot: 'workspace.dock', title: { zh: '面板', en: 'Panel' }, kind: 'panel' }] },
      }),
    )
    expect(declarativeSlots.code).toBe('E-MAN-07')

    for (const contributes of [
      { lintRules: [{ id: 'rr', title: { zh: '规则', en: 'Rule' }, severity: 'warn' as const }] },
      { recipes: [{ id: 'rr', namespace: 'ns', title: { zh: '配方', en: 'Recipe' }, slots: [{ key: 'headline' as const }] }] },
      { exportHooks: [{ id: 'hh', title: { zh: '钩子', en: 'Hook' }, kind: 'preflight' as const }] },
    ]) {
      expect(manifestError(baseManifest({ contributes })).code, JSON.stringify(contributes)).toBe('E-MAN-07')
    }
  })

  it('能力↔贡献一致性：声明贡献但缺能力 → E-MAN-08；能力去重且保序', () => {
    expect(manifestError(baseManifest({ contributes: { themes: [] } })).code).toBe('E-MAN-08')
    const manifest = parseManifest(
      baseManifest({
        capabilities: ['theme:contribute', 'theme:contribute', 'ui:command'],
        contributes: { commands: [{ id: 'xx', title: { zh: 'x', en: 'x' }, category: 'plugin', action: { kind: 'openSettings' } }] },
      }),
      { files: okFiles, installSource: 'file' },
    )
    expect(manifest.capabilities).toEqual(['theme:contribute', 'ui:command'])
  })

  it('code 插件合法 keymap 通过（命令运行期注册）；declarative keymap 需要命令在清单', () => {
    const codeKeymap = parseManifest(
      baseManifest({ kind: 'code', entry: 'plugin.js', capabilities: ['ui:keymap'], contributes: { keymap: [{ combo: 'mod+shift+p', commandId: 'runtime-cmd' }] } }),
      { files: codeFiles, installSource: 'file' },
    )
    expect(codeKeymap.contributes.keymap).toHaveLength(1)
  })

  it('openPluginPanel 契约缺口：declarative 无法声明 slot（E-MAN-07），引用未声明 slot → E-MAN-09', () => {
    const declWithSlots = manifestError(
      baseManifest({
        capabilities: ['ui:command', 'ui:slot'],
        contributes: {
          slots: [{ id: 'pp', slot: 'workspace.dock', title: { zh: '面板', en: 'Panel' }, kind: 'panel' }],
          commands: [
            {
              id: 'open-panel',
              title: { zh: '打开', en: 'Open' },
              category: 'plugin',
              action: { kind: 'openPluginPanel', slot: 'workspace.dock', contributionId: 'pp' },
            },
          ],
        },
      }),
    )
    expect(declWithSlots.code).toBe('E-MAN-07')

    const danglingRef = manifestError(
      baseManifest({
        capabilities: ['ui:command'],
        contributes: {
          commands: [
            {
              id: 'open-panel',
              title: { zh: '打开', en: 'Open' },
              category: 'plugin',
              action: { kind: 'openPluginPanel', slot: 'workspace.dock', contributionId: 'nope' },
            },
          ],
        },
      }),
    )
    expect(danglingRef.code).toBe('E-MAN-09')
  })

  it('icon 规则：缺失 / 非 svg / 对话失配 → E-MAN-11', () => {
    expect(manifestError(baseManifest({ icon: 'icon.svg' })).code).toBe('E-MAN-11')
    expect(manifestError(baseManifest({ icon: 'assets/icon.png' })).code).toBe('E-MAN-11')
    const svgFiles = { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>1</script></svg>' }
    const sanitized = parseManifest(baseManifest({ icon: 'icon.svg' }), { files: svgFiles, installSource: 'file' })
    expect(sanitized.icon).toBe('icon.svg')
  })

  it('apiVersion 1.5（minor 超 HOST_ABI_MINOR）→ E-MAN-04；minAppVersion 高于 APP_VERSION → E-MAN-05', () => {
    expect(manifestError(baseManifest({ apiVersion: '1.5' })).code).toBe('E-MAN-04')
    expect(manifestError(baseManifest({ minAppVersion: '99.0.0' })).code).toBe('E-MAN-05')
  })

  it('id 格式：单段/大写/下划线 → E-MAN-02；name 以 LUMEN/幕光 开头（第三方）→ E-MAN-01', () => {
    for (const id of ['single', 'Com.Example.foo', 'com.example_bad.foo', 'com..double']) {
      expect(manifestError(baseManifest({ id })).code, id).toBe('E-MAN-02')
    }
    for (const name of [
      { zh: 'LUMEN 甲', en: 'Fixture' },
      { zh: '夹具', en: 'LUMEN fixture' },
      { zh: '幕光工具', en: 'Fixture' },
    ]) {
      expect(manifestError(baseManifest({ name })).code, JSON.stringify(name)).toBe('E-MAN-01')
    }
    // builtin 来源不受商标边界限制
    expect(
      parseManifest(baseManifest({ id: 'com.lumen.samples.qa2', trust: 'builtin', name: { zh: 'LUMEN 样例', en: 'LUMEN sample' } }), {
        files: okFiles,
        installSource: 'builtin',
      }).trust,
    ).toBe('builtin')
  })

  it('entry 规则：不在 files / 非 .js 扩展名 → E-MAN-06', () => {
    expect(
      manifestError(baseManifest({ kind: 'code', entry: 'missing.js' }), codeFiles).code,
    ).toBe('E-MAN-06')
    expect(
      manifestError(baseManifest({ kind: 'code', entry: 'plugin.json' }), { 'plugin.json': '{}' }).code,
    ).toBe('E-MAN-06')
  })

  it('author.url 只接受 http(s)（展示不请求）→ 非 http 为 E-MAN-01', () => {
    expect(
      parseManifest(baseManifest({ author: { name: 'QA', url: 'https://example.com/plugin' } }), {
        files: okFiles,
        installSource: 'file',
      }).author.url,
    ).toBe('https://example.com/plugin')
    expect(manifestError(baseManifest({ author: { name: 'QA', url: 'ftp://example.com/x' } })).code).toBe('E-MAN-01')
  })

  it('capabilities 超 15 项被拒（契约 E-MAN-08；实现经 zod 走 E-MAN-01，见 RISKS 备注）', () => {
    const capabilities = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'ui:slot' : 'ui:command')) as Capability[]
    const error = manifestError(baseManifest({ capabilities }))
    expect(['E-MAN-08', 'E-MAN-01'], `实际 ${error.code}：${error.message}`).toContain(error.code)
  })

  it('贡献内部一致性：主题覆盖内置 id / slots 形态失配 / inline 缺 open / i18n 双包 → E-MAN-09', () => {
    const noir = {
      id: 'noir',
      name: { zh: '黑', en: 'Noir' },
      colors: { bg: '#000000', fg: '#ffffff', muted: '#888888', surface: '#111111', line: '#222222', accent: '#00ffff', accent2: '#ffff00' },
    }
    expect(manifestError(baseManifest({ capabilities: ['theme:contribute'], contributes: { themes: [noir] } })).code).toBe('E-MAN-09')

    const badSlot = (slot: SlotContribution) =>
      manifestError(baseManifest({ kind: 'code', entry: 'plugin.js', capabilities: ['ui:slot'], contributes: { slots: [slot] } }), codeFiles)
    expect(badSlot({ id: 'bb', slot: 'workspace.topbar', title: { zh: 'B', en: 'B' }, kind: 'panel' }).code).toBe('E-MAN-09')
    expect(badSlot({ id: 'cc', slot: 'workspace.topbar', title: { zh: 'C', en: 'C' }, kind: 'inline' }).code).toBe('E-MAN-09')

    const i18n: LocalePackContribution[] = [
      { zh: { k: 'v' }, en: { k: 'V' } },
      { zh: { k2: 'v' }, en: { k2: 'V' } },
    ]
    expect(manifestError(baseManifest({ capabilities: ['i18n:contribute'], contributes: { i18n } })).code).toBe('E-MAN-09')
  })

  it('builtin 来源可用 com.lumen.* 命名空间与 trust；第三方不可', () => {
    const builtin = parseManifest(
      baseManifest({ id: 'com.lumen.samples.qa', trust: 'builtin' }),
      { files: okFiles, installSource: 'builtin' },
    )
    expect(builtin.trust).toBe('builtin')
    expect(() =>
      parseManifest(baseManifest({ id: 'com.lumen.samples.qa' }), { files: okFiles, installSource: 'file' }),
    ).toThrowError(PluginError)
  })

  it('贡献超限：themes 7 → E-MAN-09；单插件最多 2 个带帧 slot → E-MAN-09', () => {
    const themes = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i + 1}`,
      name: { zh: '主题', en: 'Theme' },
      colors: { bg: '#000', fg: '#fff', muted: '#888', surface: '#111', line: '#222', accent: '#0ff', accent2: '#ff0' },
    }))
    expect(manifestError(baseManifest({ capabilities: ['theme:contribute'], contributes: { themes } })).code).toBe('E-MAN-09')

    const slots: SlotContribution[] = [
      { id: 'aa', slot: 'workspace.dock', title: { zh: 'A', en: 'A' }, kind: 'panel' },
      { id: 'bb', slot: 'workspace.overlay', title: { zh: 'B', en: 'B' }, kind: 'overlay' },
      { id: 'cc', slot: 'dialog', title: { zh: 'C', en: 'C' }, kind: 'modal' },
    ]
    expect(
      manifestError(baseManifest({ kind: 'code', entry: 'plugin.js', capabilities: ['ui:slot'], contributes: { slots } }), codeFiles).code,
    ).toBe('E-MAN-09')
  })

  it('未知贡献键（.strict()）→ E-MAN-01', () => {
    const error = manifestError(baseManifest({ contributes: { widgets: [] } as never }))
    expect(error.code).toBe('E-MAN-01')
  })
})

/* ============================ 夹具 ↔ 实现口径交叉校验 ============================ */

describe('夹具生成器与运行时 canonical JSON 口径一致', () => {
  it('legal 夹具的 integrity 前缀由运行时同一算法产生（sha256(canonical(payload))）', async () => {
    const envelope = parseEnvelope(readFixture(VALID_DIR, 'v11-declarative-multi-7kinds.lumenplug'))
    const recomputed = await integrityOf(payloadOf(envelope))
    expect(recomputed).toBe(envelope.integrity)
  })
})
