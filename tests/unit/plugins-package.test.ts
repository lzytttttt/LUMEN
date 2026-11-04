/**
 * U-40-01…06：`.lumenplug` 包格式、canonical JSON、sha256 与体积/路径校验（02 §2）。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  PACKAGE_LIMITS,
  buildEnvelope,
  bytesOf,
  canonicalJson,
  integrityOf,
  isInstallableUrl,
  parseEnvelope,
  readEnvelope,
  serializeEnvelope,
  sha256Hex,
  validatePath,
  verifyIntegrity,
} from '@/plugins/package'
import { PluginError } from '@/plugins/errors'
import type { PluginManifest } from '@/plugins/types'

beforeAll(() => {
  const current = globalThis.crypto as Crypto | undefined
  if (!current || !current.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

function code(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    if (error instanceof PluginError) return error.code
    throw error
  }
  throw new Error('expected a PluginError')
}

async function codeAsync(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof PluginError) return error.code
    throw error
  }
  throw new Error('expected a PluginError')
}

const MANIFEST: PluginManifest = {
  id: 'com.example.hello',
  name: { zh: '你好', en: 'Hello' },
  version: '1.0.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'Example' },
  description: { zh: '示例插件', en: 'Example plugin' },
  license: 'MIT',
  capabilities: ['theme:contribute'],
  contributes: {
    themes: [
      {
        id: 'sepia',
        name: { zh: '棕褐', en: 'Sepia' },
        colors: {
          bg: '#201a12',
          fg: '#f3e9d2',
          muted: '#a99a7c',
          surface: '#2c241a',
          line: '#4a3d2c',
          accent: '#d8a657',
          accent2: '#7fa7a0',
        },
      },
    ],
  },
}

const FILES: Record<string, string> = {
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg>',
}

describe('canonicalJson（02 §2.4 六条规则）', () => {
  it('对象键递归升序、数组保序、无空白', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2], c: { z: 1, y: 2 } })).toBe('{"a":[3,1,2],"b":1,"c":{"y":2,"z":1}}')
  })

  it('键排序按 UTF-16 code unit（大写在小写前）', () => {
    expect(canonicalJson({ a: 1, A: 2, b: 3 })).toBe('{"A":2,"a":1,"b":3}')
  })

  it('非 ASCII 原样输出、控制字符用 \\uXXXX、引号与反斜杠最小转义', () => {
    expect(canonicalJson('幕光')).toBe('"幕光"')
    expect(canonicalJson('a\nb\tc')).toBe('"a\\u000ab\\u0009c"')
    expect(canonicalJson('"\\')).toBe('"\\"\\\\"')
  })

  it('数字：-0 归一为 0、安全整数保留、浮点按最短往返序列化', () => {
    expect(canonicalJson(-0)).toBe('0')
    expect(canonicalJson([0, -1, 42])).toBe('[0,-1,42]')
    expect(canonicalJson(0.5)).toBe('0.5')
    expect(canonicalJson(1.02)).toBe('1.02')
  })

  it('NaN / Infinity / 非安全整数 → E-PKG-01', () => {
    expect(code(() => canonicalJson(Number.NaN))).toBe('E-PKG-01')
    expect(code(() => canonicalJson(Number.POSITIVE_INFINITY))).toBe('E-PKG-01')
    expect(code(() => canonicalJson(Number.MAX_SAFE_INTEGER + 2))).toBe('E-PKG-01')
  })

  it('undefined / 函数 / symbol / BigInt / 非纯对象 → E-PKG-01', () => {
    expect(code(() => canonicalJson(undefined))).toBe('E-PKG-01')
    expect(code(() => canonicalJson({ a: undefined }))).toBe('E-PKG-01')
    expect(code(() => canonicalJson(() => 1))).toBe('E-PKG-01')
    expect(code(() => canonicalJson(Symbol('x')))).toBe('E-PKG-01')
    expect(code(() => canonicalJson({ a: BigInt(1) }))).toBe('E-PKG-01')
    expect(code(() => canonicalJson(new Date()))).toBe('E-PKG-01')
  })

  it('顶层 null / 布尔 / 空对象稳定', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
  })

  it('同一逻辑数据的两种键序产出同一字节串', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('拒绝过深嵌套（防护）', () => {
    let deep: unknown = 1
    for (let index = 0; index < 80; index += 1) deep = { next: deep }
    expect(code(() => canonicalJson(deep))).toBe('E-PKG-01')
  })
})

describe('sha256 / integrity（02 §2.4）', () => {
  it('sha256Hex 返回小写 hex（已知向量 "abc"）', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('sha256 是 sha256Hex 的别名（async）', async () => {
    const { sha256 } = await import('@/plugins/package')
    expect(await sha256('abc')).toBe(await sha256Hex('abc'))
  })

  it('bytesOf 按 UTF-8 计字节', () => {
    expect(bytesOf('abc')).toBe(3)
    expect(bytesOf('幕光')).toBe(6)
    expect(bytesOf('😀')).toBe(4)
  })

  it('integrityOf = sha256:<64 hex>，且与 key 顺序无关', async () => {
    const first = await integrityOf({ a: 1, b: 2 })
    const second = await integrityOf({ b: 2, a: 1 })
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first).toBe(second)
  })

  it('buildEnvelope → verifyIntegrity 往返通过；篡改 manifest → E-PKG-05', async () => {
    const envelope = await buildEnvelope({ manifest: MANIFEST, files: FILES, createdAt: 1_700_000_000_000 })
    await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()
    const tampered = {
      ...envelope,
      manifest: { ...envelope.manifest, name: { zh: '篡改', en: 'Tampered' } },
    }
    expect(await codeAsync(() => verifyIntegrity(tampered))).toBe('E-PKG-05')
  })

  it('serializeEnvelope 用 canonical JSON（字节稳定）', async () => {
    const envelope = await buildEnvelope({ manifest: MANIFEST, files: FILES, createdAt: 1_700_000_000_000 })
    expect(serializeEnvelope(envelope)).toBe(canonicalJson(envelope))
    expect(serializeEnvelope(envelope)).not.toContain('\n')
  })
})

describe('parseEnvelope（02 §3.1 步骤 2 + §2.2）', () => {
  async function envelopeText(overrides: Record<string, unknown> = {}, files: Record<string, string> = FILES): Promise<string> {
    const envelope = await buildEnvelope({ manifest: MANIFEST, files, createdAt: 1_700_000_000_000 })
    return canonicalJson({ ...envelope, ...overrides })
  }

  it('合法信封可解析', async () => {
    const parsed = parseEnvelope(await envelopeText())
    expect(parsed.format).toBe('lumen-plugin')
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.manifest.id).toBe('com.example.hello')
  })

  it('坏 JSON → E-PKG-01；顶层非对象 → E-PKG-01', async () => {
    expect(code(() => parseEnvelope('{'))).toBe('E-PKG-01')
    expect(code(() => parseEnvelope('[]'))).toBe('E-PKG-01')
  })

  it('未知顶层字段 → E-PKG-01（白名单）', () => {
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), extra: 1 })))).toBe('E-PKG-01')
  })

  it('format / formatVersion 不支持 → E-PKG-02', async () => {
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), format: 'zip' })))).toBe('E-PKG-02')
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), formatVersion: 2 })))).toBe('E-PKG-02')
  })

  it('缺 manifest / files → E-PKG-03', () => {
    const base = sampleEnvelope()
    const { manifest: _manifest, ...withoutManifest } = base
    const { files: _files, ...withoutFiles } = base
    expect(code(() => parseEnvelope(canonicalJson(withoutManifest)))).toBe('E-PKG-03')
    expect(code(() => parseEnvelope(canonicalJson(withoutFiles)))).toBe('E-PKG-03')
  })

  it('createdAt 越界 / 非法 → E-PKG-01', () => {
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), createdAt: 1 })))).toBe('E-PKG-01')
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), createdAt: Date.now() + 2 * 86_400_000 })))).toBe('E-PKG-01')
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), createdAt: 1.5 })))).toBe('E-PKG-01')
  })

  it('integrity 形状非法 → E-PKG-01；大写 hex 非法', () => {
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), integrity: 'sha256:XYZ' })))).toBe('E-PKG-01')
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), integrity: `sha256:${'A'.repeat(64)}` })))).toBe('E-PKG-01')
  })

  it('体积超限 → E-PKG-04（读入前断流）', async () => {
    const text = await envelopeText()
    expect(code(() => parseEnvelope(text, { maxBytes: 32 }))).toBe('E-PKG-04')
  })

  it('文件数量超限 → E-PKG-04', async () => {
    const many: Record<string, string> = {}
    for (let index = 0; index <= PACKAGE_LIMITS.maxFiles; index += 1) many[`f${index}.txt`] = 'x'
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), files: many })))).toBe('E-PKG-04')
  })

  it('单文件超限 → E-PKG-04', async () => {
    const files = { 'big.txt': 'x'.repeat(PACKAGE_LIMITS.maxFileBytes + 1) }
    const text = await envelopeText({}, files)
    expect(code(() => parseEnvelope(text))).toBe('E-PKG-04')
  })

  it('files 中出现 .lumen-plugin.json → E-PKG-06', async () => {
    const text = await envelopeText({}, { '.lumen-plugin.json': '{}' })
    expect(code(() => parseEnvelope(text))).toBe('E-PKG-06')
  })

  it('非字符串文件值（二进制）→ E-PKG-01', async () => {
    expect(code(() => parseEnvelope(canonicalJson({ ...sampleEnvelope(), files: { 'a.txt': 123 } })))).toBe('E-PKG-01')
  })

  it('entry 不在 files → E-MAN-06；entry 非 .js → E-MAN-06', async () => {
    const manifestWithEntry = { ...MANIFEST, kind: 'code' as const, entry: 'plugin.js' }
    const envelope = await buildEnvelope({ manifest: manifestWithEntry, files: FILES, createdAt: 1_700_000_000_000 })
    expect(code(() => parseEnvelope(canonicalJson(envelope)))).toBe('E-MAN-06')
    const envelope2 = await buildEnvelope({
      manifest: { ...manifestWithEntry, entry: 'entry.json' },
      files: { ...FILES, 'entry.json': '{}' },
      createdAt: 1_700_000_000_000,
    })
    expect(code(() => parseEnvelope(canonicalJson(envelope2)))).toBe('E-MAN-06')
  })

  it('入口文件超过 256KB → E-PKG-04', async () => {
    const manifest = { ...MANIFEST, kind: 'code' as const, entry: 'plugin.js' }
    const files = { 'plugin.js': `/*${'x'.repeat(PACKAGE_LIMITS.maxEntryBytes)}*/` }
    const envelope = await buildEnvelope({ manifest, files, createdAt: 1_700_000_000_000 })
    expect(code(() => parseEnvelope(canonicalJson(envelope)))).toBe('E-PKG-04')
  })
})

describe('validatePath（02 §2.2）', () => {
  it('合法路径', () => {
    for (const path of ['plugin.js', 'icon.svg', 'assets/logo.svg', 'locales/zh.json']) {
      expect(() => validatePath(path)).not.toThrow()
    }
  })

  it('非法路径 → E-PKG-06', () => {
    for (const path of ['../evil.js', 'a/../../b.js', '/abs.js', 'C:/x.js', 'Upper.js', 'a b.js', 'a\\b.js', 'node_modules/x.js', 'a/b/c/d.js', 'a.js/']) {
      expect(code(() => validatePath(path))).toBe('E-PKG-06')
    }
  })

  it('非法扩展名 → E-PKG-06', () => {
    for (const path of ['plugin.html', 'a.png', 'a.zip', 'noext']) {
      expect(code(() => validatePath(path))).toBe('E-PKG-06')
    }
  })
})

describe('readEnvelope / URL（02 §3.1 步骤 1）', () => {
  it('从字符串与 Blob 读入', async () => {
    const text = canonicalJson(sampleEnvelope())
    expect(parseEnvelope(text).manifest.id).toBe(MANIFEST.id)
    const fromBlob = await readEnvelope(new Blob([text]))
    expect(fromBlob.manifest.id).toBe(MANIFEST.id)
  })

  it('URL 安装只认 https（回环地址允许 http）', () => {
    expect(isInstallableUrl('https://example.com/a.lumenplug')).toBe(true)
    expect(isInstallableUrl('http://127.0.0.1:5274/a.lumenplug')).toBe(true)
    expect(isInstallableUrl('http://localhost/a.lumenplug')).toBe(true)
    expect(isInstallableUrl('http://example.com/a.lumenplug')).toBe(false)
    expect(isInstallableUrl('file:///a.lumenplug')).toBe(false)
    expect(isInstallableUrl('javascript:alert(1)')).toBe(false)
  })
})

/** 便于反例构造的合法信封骨架（不参与 integrity 校验的 parse 阶段）。 */
function sampleEnvelope() {
  return {
    format: 'lumen-plugin',
    formatVersion: 1,
    createdAt: 1_700_000_000_000,
    integrity: `sha256:${'0'.repeat(64)}`,
    manifest: MANIFEST,
    files: FILES,
  }
}
