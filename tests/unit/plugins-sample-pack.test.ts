/**
 * tests/unit/plugins-sample-pack.test.ts —— 三款样例的打包契约（02 §2.1/§2.2/§2.4 + 05 §2/§7）。
 *
 * 这一层是「发布物」的验收：`scripts/pack-plugins.mjs` 生成的信封必须能被**宿主自己的解析器**
 * （`src/plugins/package.ts` / `manifest.ts`）原样接受，integrity 必须与宿主 canonicalJson 逐字节一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  canonicalJson as hostCanonicalJson,
  bytesOf,
  parseEnvelope,
  payloadOf,
  sha256Hex as hostSha256Hex,
  verifyIntegrity,
} from '@/plugins/package'
import { parseManifest, scanSource } from '@/plugins/manifest'
import type { PluginEnvelope } from '@/plugins/types'
import { allMessageKeys } from '@/i18n'
import { CAPABILITY_I18N_KEY, SAMPLE_CATALOG, samplePackagePath } from '@/pages/plugins/samples'

interface SampleSpec {
  name: string
  id: string
  budgetBytes: number
  capabilities: number
  frameSlots: number
  sensitive: boolean
  expectLintRules: number
  expectRecipes: number
  expectExportHooks: number
}

interface BuildResult {
  sample: SampleSpec
  envelope: PluginEnvelope & { manifest: Record<string, unknown>; files: Record<string, string> }
  serialized: string
  integrity: string
  envelopeBytes: number
  stats: { totalBytes: number; entryBytes: number; iconBytes: number; fileCount: number }
  versionedName: string
  aliasName: string
}

interface PackModule {
  SAMPLES: SampleSpec[]
  PACKAGE_LIMITS: Record<string, number>
  ENVELOPE_CREATED_AT: number
  canonicalJson(value: unknown): string
  sha256Hex(text: string): string
  computeIntegrity(manifest: unknown, files: Record<string, string>, createdAt?: number): { payload: unknown; integrity: string }
  verifyEnvelope(envelope: unknown): { ok: boolean; expected: string; actual: string }
  buildEnvelope(name: string): BuildResult
  buildAll(): BuildResult[]
  PUBLIC_OUT_DIR: string
  FIXTURE_OUT_DIR: string
  SOURCE_DIR: string
}

let pack: PackModule
let results: BuildResult[]

beforeAll(async () => {
  // 宿主 integrity 走 crypto.subtle；jsdom 环境没有，换成 Node 的 WebCrypto。
  vi.stubGlobal('crypto', webcrypto)
  const url = pathToFileURL(resolve(process.cwd(), 'scripts', 'pack-plugins.mjs')).href
  pack = (await import(/* @vite-ignore */ url)) as unknown as PackModule
  results = pack.buildAll()
})

/* -------------------------- canonical JSON / sha256 -------------------------- */

describe('canonicalJson 与宿主逐字节一致（02 §2.4）', () => {
  it('三款样例的 payload 文本相等', () => {
    for (const result of results) {
      const payload = payloadOf(result.envelope)
      expect(pack.canonicalJson(payload)).toBe(hostCanonicalJson(payload))
    }
  })

  it('边界值：-0/浮点/控制字符/中文/emoji/嵌套排序', () => {
    const samples: unknown[] = [
      { b: 1, a: 2 },
      { zebra: [3, 2, 1], alpha: { y: true, x: null } },
      { text: '中文与 "引号" 和 \\反斜杠\\ 与 \u0001 控制字符\t换行\n回车\r' },
      { emoji: '😀🎉', negativeZero: -0, float: 0.25, tiny: 1e-7, ratio: 1.5 },
      [1, 'two', false, null, { k: 'v' }],
      {},
      [],
      'plain',
      42,
      true,
      null,
    ]
    for (const value of samples) expect(pack.canonicalJson(value)).toBe(hostCanonicalJson(value))
  })

  it('拒绝 NaN/Infinity/非安全整数/undefined（两侧都抛）', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      1e21,
      { v: undefined },
      [undefined],
    ]) {
      expect(() => hostCanonicalJson(bad)).toThrow()
      expect(() => pack.canonicalJson(bad)).toThrow()
    }
  })

  it('sha256 与宿主实现同值（含非 ASCII）', async () => {
    const text = pack.canonicalJson({ zh: '品牌守护', n: 3, text: 'a\nb' })
    expect(pack.sha256Hex(text)).toBe(await hostSha256Hex(text))
  })
})

/* --------------------------------- 信封 --------------------------------- */

describe('三个信封可被宿主解析（02 §2.1/§2.2）', () => {
  it('buildAll 产 3 个信封，id/版本/预算口径正确', () => {
    expect(results).toHaveLength(3)
    expect(results.map((item) => item.sample.name)).toEqual(['brandguard', 'chartkit', 'focusdesk'])
    for (const result of results) {
      expect(result.envelope.format).toBe('lumen-plugin')
      expect(result.envelope.formatVersion).toBe(1)
      expect(result.envelope.createdAt).toBe(pack.ENVELOPE_CREATED_AT)
      expect(result.envelope.manifest.id).toBe(result.sample.id)
      expect(result.envelope.manifest.version).toBe('0.1.0')
      expect(result.envelope.manifest.trust).toBe('builtin')
      expect(result.envelope.manifest.capabilities).toHaveLength(result.sample.capabilities)
      expect(result.envelopeBytes).toBeLessThanOrEqual(result.sample.budgetBytes)
      expect(result.stats.entryBytes).toBeLessThanOrEqual(255_999)
      expect(result.stats.fileCount).toBe(4)
      expect(result.versionedName).toBe(`${result.sample.name}-0.1.0.lumenplug`)
    }
  })

  it('integrity 由 canonical payload 算出，且与宿主重算一致', () => {
    for (const result of results) {
      expect(result.envelope.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      const recomputed = pack.computeIntegrity(
        result.envelope.manifest,
        result.envelope.files,
        result.envelope.createdAt,
      )
      expect(recomputed.integrity).toBe(result.envelope.integrity)
      expect(pack.verifyEnvelope(result.envelope)).toEqual({
        ok: true,
        expected: result.envelope.integrity,
        actual: result.envelope.integrity,
      })
    }
  })

  it('宿主 parseEnvelope + verifyIntegrity 原样接受（安装管线第 2/3 步）', async () => {
    for (const result of results) {
      const envelope = parseEnvelope(result.serialized)
      expect(envelope.manifest.id).toBe(result.sample.id)
      await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()
    }
  })

  it('篡改任一字节 → integrity 失配（U-40-01…30 的样例侧对照）', async () => {
    const envelope = JSON.parse(results[0].serialized) as PluginEnvelope
    envelope.manifest.version = '0.1.1'
    await expect(verifyIntegrity(envelope)).rejects.toMatchObject({ code: 'E-PKG-05' })
  })

  it('files 只含 4 个合法路径，且不含清单文件（02 §2.2）', () => {
    for (const result of results) {
      const names = Object.keys(result.envelope.files).sort()
      expect(names).toEqual(['icon.svg', 'locales/en.json', 'locales/zh.json', 'plugin.js'])
      expect(names).not.toContain('.lumen-plugin.json')
      for (const name of names) {
        expect(name).toBe(name.toLowerCase())
        expect(name).toMatch(/^(?:[a-z0-9][a-z0-9._-]*\/){0,2}[a-z0-9][a-z0-9._-]*$/)
      }
      expect(bytesOf(result.envelope.files['plugin.js'])).toBeLessThanOrEqual(256_000)
    }
  })
})

/* ---------------------------- manifest 双校验 ---------------------------- */

describe('manifest 过宿主 zod 校验（02 §2.3）', () => {
  it('parseManifest(builtin) 三款全部通过', () => {
    for (const result of results) {
      expect(() =>
        parseManifest(result.envelope.manifest, {
          installSource: 'builtin',
          appVersion: '0.4.0',
          files: result.envelope.files,
        }),
      ).not.toThrow()
    }
  })

  it('locales 已内联进 contributes.i18n，且 zh/en 键集相等 ≥12', () => {
    for (const result of results) {
      const contributes = result.envelope.manifest.contributes as Record<string, unknown>
      const i18n = contributes.i18n as { zh: Record<string, string>; en: Record<string, string> }[]
      expect(Array.isArray(i18n)).toBe(true)
      expect(i18n).toHaveLength(1)
      const zh = i18n[0].zh
      const en = i18n[0].en
      expect(Object.keys(zh).length).toBeGreaterThanOrEqual(12)
      expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    }
  })

  it('三款源码全部通过宿主 scanSource（E-MAN-12 不触发）', () => {
    for (const result of results) {
      const source = result.envelope.files['plugin.js']
      expect(scanSource(source), `${result.sample.name} 命中禁用 API`).toEqual([])
    }
  })

  it('FocusDesk 零敏感能力；BrandGuard / ChartKit 的敏感能力符合 05 §1.4', () => {
    const capabilitiesOf = (name: string): string[] =>
      results.find((item) => item.sample.name === name)?.envelope.manifest.capabilities as string[]
    const sensitive = new Set(['ai:invoke', 'deck:write', 'asset:write', 'export:hook'])
    expect(capabilitiesOf('focusdesk').filter((capability) => sensitive.has(capability))).toEqual([])
    expect(capabilitiesOf('brandguard').filter((capability) => sensitive.has(capability)).sort()).toEqual([
      'asset:write',
      'deck:write',
      'export:hook',
    ])
    expect(capabilitiesOf('chartkit').filter((capability) => sensitive.has(capability))).toEqual(['deck:write'])
  })
})

/* ------------------------------- 发布物 ------------------------------- */

describe('发布物落盘（07 §1）', () => {
  it('public/plugins/samples 有 6 个文件（版本号权威 + 无版本 alias）', () => {
    for (const result of results) {
      const versioned = resolve(pack.PUBLIC_OUT_DIR, result.versionedName)
      const alias = resolve(pack.PUBLIC_OUT_DIR, result.aliasName)
      expect(existsSync(versioned), `缺少 ${versioned}`).toBe(true)
      expect(existsSync(alias), `缺少 ${alias}`).toBe(true)
      expect(readFileSync(versioned, 'utf8')).toBe(result.serialized)
      expect(readFileSync(alias, 'utf8')).toBe(result.serialized)
    }
  })

  it('tests/fixtures/plugins/samples 有 3 个夹具包，内容与发布物一致', () => {
    for (const result of results) {
      const path = resolve(pack.FIXTURE_OUT_DIR, result.aliasName)
      expect(existsSync(path), `缺少 ${path}`).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(result.serialized)
    }
  })

  it('产物可直接被宿主解析并安装（三份 round-trip）', async () => {
    for (const result of results) {
      const text = readFileSync(resolve(pack.PUBLIC_OUT_DIR, result.versionedName), 'utf8')
      const envelope = parseEnvelope(text)
      await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()
      expect(envelope.files['plugin.js'].length).toBeGreaterThan(100)
    }
  })
})

/* ------------------------- 插件页元数据与钩子（05 §7 / 06 §3.1） ------------------------- */

function readPageSource(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', 'pages', 'plugins', name), 'utf8')
}

function readPackSizes(): { samples: Record<string, { version: string; envelopeBytes: number; entryBytes: number; integrity: string }> } {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'src', 'pages', 'plugins', 'pack-sizes.json'), 'utf8'))
}

describe('插件页元数据与打包产物对拍', () => {
  it('pack-sizes.json 与真实信封逐项一致（页面体积由此派生，不再手写）', () => {
    const sizes = readPackSizes()
    for (const result of results) {
      const entry = sizes.samples[result.sample.name]
      expect(entry, `pack-sizes 缺少 ${result.sample.name}`).toBeTruthy()
      expect(entry.version).toBe(result.envelope.manifest.version)
      expect(entry.envelopeBytes).toBe(result.envelopeBytes)
      expect(entry.entryBytes).toBe(result.stats.entryBytes)
      expect(entry.integrity).toBe(result.integrity)
    }
  })

  it('SAMPLE_CATALOG 的 id/版本/体积/能力与真实信封一致', () => {
    expect(SAMPLE_CATALOG).toHaveLength(3)
    const sizes = readPackSizes()
    for (const result of results) {
      const entry = SAMPLE_CATALOG.find((sample) => sample.id === result.sample.name)
      expect(entry, `catalog 缺少 ${result.sample.name}`).toBeTruthy()
      expect(entry?.pluginId).toBe(result.envelope.manifest.id)
      expect(entry?.version).toBe(result.envelope.manifest.version)
      expect(entry?.version).toBe(sizes.samples[result.sample.name].version)
      // 页面显示体积 = pack-sizes 的 envelopeBytes 向上取整（唯一口径，防手工漂移）
      expect(entry?.sizeKb).toBe(Math.ceil(sizes.samples[result.sample.name].envelopeBytes / 1024))
      expect(entry?.sizeKb).toBe(Math.ceil(result.envelopeBytes / 1024))
      expect(entry?.capabilities).toEqual(result.envelope.manifest.capabilities)
      expect(samplePackagePath(result.sample.name as 'brandguard' | 'chartkit' | 'focusdesk')).toBe(
        `./plugins/samples/${result.sample.name}-${result.envelope.manifest.version}.lumenplug`,
      )
    }
  })

  it('插件页源码包含 06 §3.1 冻结钩子，以及「安装 → 回工作台」链路', () => {
    const page = readPageSource('PluginsPage.tsx')
    for (const hook of [
      'data-sample-card',
      'data-install-sample',
      'data-download-sample',
      'data-install-state',
      'data-permission',
      'data-granted',
      'data-devdocs',
      'data-no-market',
      'data-default-off',
    ]) {
      expect(page, `页面缺少钩子 ${hook}`).toContain(hook)
    }
    // 安装后：卡片进入 installed 态，并给出回到工作台的入口（qa 的安装链路断言依赖这两点）
    expect(page).toContain("state.status === 'installed'")
    expect(page).toContain("key('pluginspage.install.open')")
    expect(page).toContain('installBuiltinSample')
    const html = readFileSync(resolve(process.cwd(), 'plugins.html'), 'utf8')
    expect(html).toContain('data-lumen-plugins-page="1"')
    expect(html).toContain('still')
  })

  it('页面引用的 pluginspage.* / plugin.capability.* 键在宿主词典里都存在', () => {
    const keys = new Set(allMessageKeys())
    const page = readPageSource('PluginsPage.tsx')
    const literal = [...page.matchAll(/'pluginspage\.[a-zA-Z0-9._]+'/g)].map((match) => match[0].slice(1, -1))
    expect(literal.length).toBeGreaterThan(10)
    for (const found of literal) expect(keys.has(found), `缺少 i18n 键 ${found}`).toBe(true)
    for (const sample of ['brandguard', 'chartkit', 'focusdesk']) {
      expect(keys.has(`pluginspage.sample.${sample}.name`)).toBe(true)
      expect(keys.has(`pluginspage.sample.${sample}.desc`)).toBe(true)
    }
    for (const index of [1, 2, 3, 4]) {
      expect(keys.has(`pluginspage.faq.q${index}`)).toBe(true)
      expect(keys.has(`pluginspage.faq.a${index}`)).toBe(true)
    }
    for (const suffix of Object.values(CAPABILITY_I18N_KEY)) {
      expect(keys.has(`plugin.capability.${suffix}`), `缺少能力文案键 plugin.capability.${suffix}`).toBe(true)
    }
  })

  it('页面不发网络请求、不直写插件存储（安装只走 public 门面或下载）', () => {
    const page = readPageSource('PluginsPage.tsx')
    expect(page).not.toMatch(/\bfetch\s*\(/)
    expect(page).not.toMatch(/XMLHttpRequest|localStorage|indexedDB/)
    expect(page).toContain("import('@/plugins/public')")
  })
})
