/**
 * 插件夹具构建/守卫（task-2 交付物 11；06 §8 的 hello ×3 + play.overlay + 坏插件 ×4）。
 *
 * 本测试做两件事：
 * 1. 从源目录（`.lumen-plugin.json` + `plugin.js` + `icon.svg`）用**正式管线**（`buildEnvelope`）
 *    生成 `<dir>/<name>.lumenplug`（确定性：固定 createdAt），保证 e2e/单测拿到的是合法包；
 * 2. 反向断言夹具体积上限（hello ≤8KB、bad ≤4KB，06 §8）与错误码（bad-manifest → E-MAN-03）。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import { buildEnvelope, canonicalJson, parseEnvelope, verifyIntegrity } from '@/plugins/package'
import { parseManifest } from '@/plugins/manifest'
import { PluginError } from '@/plugins/errors'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugins')
const CREATED_AT = 1_700_000_000_000

const HELLO_FIXTURES = ['hello-theme', 'hello-dock', 'hello-topbar', 'hello-playoverlay'] as const
const BAD_FIXTURES = ['crash', 'flood', 'escape', 'bad-manifest'] as const

beforeAll(() => {
  const current = globalThis.crypto as Crypto | undefined
  if (!current || !current.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

interface FixtureSource {
  dir: string
  name: string
  manifestJson: unknown
  files: Record<string, string>
}

function readSource(dir: string, name: string): FixtureSource {
  const manifestPath = join(dir, '.lumen-plugin.json')
  const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir)) {
    if (entry === '.lumen-plugin.json' || entry.endsWith('.lumenplug')) continue
    const path = join(dir, entry)
    if (!statSync(path).isFile()) continue
    files[entry] = readFileSync(path, 'utf8')
  }
  return { dir, name, manifestJson, files }
}

async function materialize(source: FixtureSource): Promise<{ text: string; path: string }> {
  const envelope = await buildEnvelope({
    manifest: source.manifestJson as never,
    files: source.files,
    createdAt: CREATED_AT,
  })
  const text = canonicalJson(envelope)
  const path = join(source.dir, `${source.name}.lumenplug`)
  // 每次测试都重写：源文件是最小改动面，产物永远可从源重建（确定性内容，不会 flaky）。
  writeFileSync(path, text, 'utf8')
  return { text, path }
}

describe('hello 夹具（合法包，e2e/插槽单测复用）', () => {
  it('hello-theme：声明式主题包通过 manifest 校验且含主题/命令/i18n', async () => {
    const source = readSource(join(FIXTURE_ROOT, 'hello-theme'), 'hello-theme')
    const { text, path } = await materialize(source)
    expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024)
    const envelope = parseEnvelope(text)
    await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()
    const manifest = parseManifest(envelope.manifest, { files: envelope.files, installSource: 'file' })
    expect(manifest.kind).toBe('declarative')
    expect(manifest.contributes.themes?.[0].id).toBe('neon')
    expect(manifest.contributes.commands?.[0].action.kind).toBe('setTheme')
    expect(manifest.contributes.i18n?.[0].zh['toast.applied']).toBeTruthy()
  })

  it('hello-dock：代码式插件 entry 预检通过且 dock 插槽贡献合法', async () => {
    const source = readSource(join(FIXTURE_ROOT, 'hello-dock'), 'hello-dock')
    const { text, path } = await materialize(source)
    expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024)
    const envelope = parseEnvelope(text)
    await expect(verifyIntegrity(envelope)).resolves.toBeUndefined()
    const manifest = parseManifest(envelope.manifest, { files: envelope.files })
    expect(manifest.kind).toBe('code')
    expect(manifest.entry).toBe('plugin.js')
    expect(manifest.contributes.slots?.[0].slot).toBe('workspace.dock')
  })

  it('hello-topbar：inline 入口 + dialog 目标的 open 绑定合法', async () => {
    const source = readSource(join(FIXTURE_ROOT, 'hello-topbar'), 'hello-topbar')
    const { text } = await materialize(source)
    const envelope = parseEnvelope(text)
    const manifest = parseManifest(envelope.manifest, { files: envelope.files })
    const slots = manifest.contributes.slots ?? []
    expect(slots).toHaveLength(2)
    expect(slots[0].kind).toBe('inline')
    expect(slots[0].open?.contributionId).toBe('hello-dialog')
    expect(slots[1].slot).toBe('dialog')
  })

  it('hello-playoverlay：play.overlay 贡献合法（V-40-13 夹具）', async () => {
    const source = readSource(join(FIXTURE_ROOT, 'hello-playoverlay'), 'hello-playoverlay')
    const { text } = await materialize(source)
    const envelope = parseEnvelope(text)
    const manifest = parseManifest(envelope.manifest, { files: envelope.files })
    expect(manifest.contributes.slots?.[0].slot).toBe('play.overlay')
    expect(manifest.contributes.slots?.[0].kind).toBe('overlay')
  })
})

describe('坏插件夹具（红队用，S-40-*）', () => {
  it('四份坏夹具 ≤4KB 且信封合法（代码/清单层面的坏，不是坏 JSON）', async () => {
    for (const name of BAD_FIXTURES) {
      const source = readSource(join(FIXTURE_ROOT, 'bad', name), name)
      const { text, path } = await materialize(source)
      expect(statSync(path).size, name).toBeLessThanOrEqual(4 * 1024)
      expect(() => parseEnvelope(text), name).not.toThrow()
    }
  })

  it('bad-manifest 的 version 非 semver → E-MAN-03', async () => {
    const source = readSource(join(FIXTURE_ROOT, 'bad', 'bad-manifest'), 'bad-manifest')
    const { text } = await materialize(source)
    const envelope = parseEnvelope(text)
    try {
      parseManifest(envelope.manifest, { files: envelope.files })
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as PluginError).code).toBe('E-MAN-03')
      return
    }
    throw new Error('bad-manifest 未被拒绝')
  })

  it('三个行为坏夹具的入口预检能通过（坏在运行期，由沙箱/隔离兜底）', async () => {
    for (const name of ['crash', 'flood', 'escape']) {
      const source = readSource(join(FIXTURE_ROOT, 'bad', name), name)
      const { text } = await materialize(source)
      const envelope = parseEnvelope(text)
      expect(() => parseManifest(envelope.manifest, { files: envelope.files }), name).not.toThrow()
    }
  })
})

describe('源目录完整性', () => {
  it('hello-* 源目录都存在（防止夹具被误删）', () => {
    for (const name of HELLO_FIXTURES) {
      expect(existsSync(join(FIXTURE_ROOT, name, '.lumen-plugin.json')), name).toBe(true)
    }
    for (const name of BAD_FIXTURES) {
      expect(existsSync(join(FIXTURE_ROOT, 'bad', name, '.lumen-plugin.json')), name).toBe(true)
    }
  })
})
