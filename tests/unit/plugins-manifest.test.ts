/**
 * U-40-07…30：manifest zod 约束、版本三件套、命名空间、贡献形状与源码预检（02 §2.3–§2.6 / §6）。
 */
import { describe, expect, it } from 'vitest'
import {
  HOST_ABI_VERSION,
  assertSourceSafe,
  compareSemver,
  isApiVersionSupported,
  isValidKeymapCombo,
  parseManifest,
  scanSource,
} from '@/plugins/manifest'
import { PluginError } from '@/plugins/errors'
import type { PluginManifest } from '@/plugins/types'

function base(): Record<string, unknown> {
  return {
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
}

function patch(mutate: (manifest: Record<string, unknown>) => void): Record<string, unknown> {
  const manifest = base()
  mutate(manifest)
  return manifest
}

function expectCode(operation: () => unknown, expected: string): void {
  try {
    operation()
  } catch (error) {
    if (!(error instanceof PluginError)) {
      throw new Error(`expected ${expected}, got non-PluginError: ${String(error)}`)
    }
    expect(error.code, `message: ${error.message}`).toBe(expected)
    return
  }
  throw new Error(`expected ${expected}, but nothing was thrown`)
}

const CLEAN_SOURCE = 'const root = document.getElementById("lumen-root")\nwindow.lumen.ui.onRender(function () {})\n'

function codeManifest(): Record<string, unknown> {
  return {
    ...base(),
    kind: 'code',
    entry: 'plugin.js',
    capabilities: ['ui:slot'],
    contributes: {
      slots: [{ id: 'dock', slot: 'workspace.dock', title: { zh: '看板', en: 'Board' }, kind: 'panel' }],
    },
  }
}

describe('合法清单', () => {
  it('声明式主题清单通过并规整能力（去重 + 02 §5.1 顺序）', () => {
    const manifest = parseManifest(patch((m) => {
      m.capabilities = ['theme:contribute', 'theme:contribute', 'storage']
    }))
    expect(manifest.capabilities).toEqual(['theme:contribute', 'storage'])
    expect(manifest.contributes.themes?.[0].id).toBe('sepia')
  })

  it('代码式清单通过（entry 在 files 且源码预检干净）', () => {
    const manifest = parseManifest(codeManifest(), { files: { 'plugin.js': CLEAN_SOURCE } })
    expect(manifest.kind).toBe('code')
    expect(manifest.entry).toBe('plugin.js')
  })

  it('内置插件（installSource builtin + trust builtin）允许 com.lumen.* 与 LUMEN 名称', () => {
    const manifest = parseManifest(
      patch((m) => {
        m.id = 'com.lumen.samples.chartkit'
        m.trust = 'builtin'
        m.name = { zh: 'LUMEN 图表', en: 'LUMEN Chart' }
      }),
      { installSource: 'builtin' },
    )
    expect(manifest.trust).toBe('builtin')
  })
})

describe('id 命名空间（02 §2.3 / §2.6，E-MAN-02）', () => {
  it('单段 / 大写 / 下划线 / 连续点 / 过长 → E-MAN-02', () => {
    for (const id of ['single', 'Com.Example.Hello', 'com.example_1.x', 'com..example', 'a.b']) {
      expectCode(() => parseManifest(patch((m) => { m.id = id })), id === 'single' ? 'E-MAN-02' : 'E-MAN-02')
    }
  })

  it('第三方用 com.lumen.* 或任意含 lumen 的段 → E-MAN-02', () => {
    for (const id of ['com.lumen.evil', 'org.example.lumen.plugin']) {
      expectCode(() => parseManifest(patch((m) => { m.id = id })), 'E-MAN-02')
    }
  })

  it('5 段以上 → E-MAN-02', () => {
    expectCode(() => parseManifest(patch((m) => { m.id = 'a.b.c.d.e.f' })), 'E-MAN-02')
  })
})

describe('trust 防伪（E-MAN-10）', () => {
  it('文件安装伪造 trust:"builtin" → 剥离并回调 E-MAN-10', () => {
    const warnings: string[] = []
    const manifest = parseManifest(
      patch((m) => {
        m.trust = 'builtin'
      }),
      { installSource: 'file', onWarning: (warningCode) => warnings.push(warningCode) },
    )
    expect(manifest.trust).toBeUndefined()
    expect(warnings).toEqual(['E-MAN-10'])
  })
})

describe('版本三件套（02 §2.5）', () => {
  it('version 非 semver → E-MAN-03', () => {
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', '']) {
      expectCode(() => parseManifest(patch((m) => { m.version = version })), 'E-MAN-03')
    }
  })

  it('apiVersion 不支持 → E-MAN-04（major≠1 与 minor>host 都拒）', () => {
    for (const apiVersion of ['2.0', '1.5', '0.9', '1', 'x.y']) {
      expectCode(() => parseManifest(patch((m) => { m.apiVersion = apiVersion })), 'E-MAN-04')
    }
    expect(isApiVersionSupported('1.0')).toBe(true)
    expect(HOST_ABI_VERSION).toBe('1.0')
  })

  it('minAppVersion 高于 App → E-MAN-05；低于/等于通过', () => {
    expectCode(() => parseManifest(patch((m) => { m.minAppVersion = '99.0.0' })), 'E-MAN-05')
    expect(() => parseManifest(patch((m) => { m.minAppVersion = '0.3.0' }))).not.toThrow()
    expect(() => parseManifest(patch((m) => { m.minAppVersion = '0.4.0' }))).not.toThrow()
  })

  it('compareSemver 语义', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('0.4.0', '0.4.0')).toBe(0)
  })
})

describe('kind 与 entry（E-MAN-06 / E-MAN-07）', () => {
  it('code 缺 entry / entry 不在 files / 扩展名非 js → E-MAN-06', () => {
    expectCode(() => parseManifest(patch((m) => { m.kind = 'code' })), 'E-MAN-06')
    expectCode(() => parseManifest(codeManifest(), { files: { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' } }), 'E-MAN-06')
    expectCode(() => parseManifest({ ...codeManifest(), entry: 'entry.json' }, { files: { 'entry.json': '{}' } }), 'E-MAN-06')
  })

  it('declarative 带 entry / slots / lintRules / recipes / exportHooks → E-MAN-07', () => {
    expectCode(() => parseManifest(patch((m) => { m.entry = 'plugin.js' })), 'E-MAN-07')
    for (const key of ['slots', 'lintRules', 'recipes', 'exportHooks']) {
      expectCode(
        () =>
          parseManifest(
            patch((m) => {
              ;(m.contributes as Record<string, unknown>)[key] = []
            }),
          ),
        'E-MAN-07',
      )
    }
  })

  it('code 带 contributes.commands → E-MAN-07（运行期注册，不双声明）', () => {
    expectCode(
      () =>
        parseManifest(
          {
            ...codeManifest(),
            capabilities: ['ui:slot', 'ui:command'],
            contributes: {
              commands: [{ id: 'go', title: { zh: '去', en: 'Go' }, category: 'plugin', action: { kind: 'toast', message: { zh: '好', en: 'OK' } } }],
            },
          },
          { files: { 'plugin.js': CLEAN_SOURCE } },
        ),
      'E-MAN-07',
    )
  })
})

describe('字段级约束（E-MAN-01）', () => {
  it('name 空 / 超 24 / 含控制字符 → E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.name = { zh: '  ', en: 'Hello' } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.name = { zh: 'x'.repeat(25), en: 'Hello' } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.name = { zh: 'a\u0001b', en: 'Hello' } })), 'E-MAN-01')
  })

  it('第三方名称以 LUMEN / 幕光 开头 → E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.name = { zh: '幕光助手', en: 'Helper' } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.name = { zh: '助手', en: 'LUMEN helper' } })), 'E-MAN-01')
  })

  it('author 空 / 超 64 / url 非 http(s) → E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.author = { name: '' } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.author = { name: 'x'.repeat(65) } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.author = { name: 'A', url: 'ftp://x' } })), 'E-MAN-01')
  })

  it('description 超 160 / license 空 → E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.description = { zh: 'x'.repeat(161), en: 'x' } })), 'E-MAN-01')
    expectCode(() => parseManifest(patch((m) => { m.license = '  ' })), 'E-MAN-01')
  })

  it('未知字段（manifest / contributes / 贡献对象）一律 E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.unknownField = 1 })), 'E-MAN-01')
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            ;(m.contributes as Record<string, unknown>).unknown = []
          }),
        ),
      'E-MAN-01',
    )
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            ;(m.contributes as { themes: Array<Record<string, unknown>> }).themes[0].extra = true
          }),
        ),
      'E-MAN-01',
    )
  })

  it('contributes.settings 必须是单对象（数组 → E-MAN-01）', () => {
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            ;(m.contributes as Record<string, unknown>).settings = []
          }),
        ),
      'E-MAN-01',
    )
  })

  it('kind 非法 → E-MAN-01', () => {
    expectCode(() => parseManifest(patch((m) => { m.kind = 'hybrid' })), 'E-MAN-01')
  })
})

describe('能力（E-MAN-08）', () => {
  it('未知能力 → E-MAN-08', () => {
    expectCode(() => parseManifest(patch((m) => { m.capabilities = ['theme:contribute', 'net:fetch'] })), 'E-MAN-08')
  })

  it('贡献缺对应能力 → E-MAN-08', () => {
    expectCode(() => parseManifest(patch((m) => { m.capabilities = [] })), 'E-MAN-08')
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            m.capabilities = ['theme:contribute']
            ;(m.contributes as Record<string, unknown>).settings = {
              id: 'main',
              title: { zh: '设置', en: 'Settings' },
              fields: [{ key: 'brand', type: 'text', label: { zh: '品牌', en: 'Brand' } }],
            }
          }),
        ),
      'E-MAN-08',
    )
  })

  it('capabilities 超过 15 项 → E-MAN-08（02 §2.3 该行失败码）', () => {
    const caps = Array.from({ length: 16 }, (_, index) => (index === 0 ? 'storage' : 'deck:read'))
    expectCode(() => parseManifest(patch((m) => { m.capabilities = caps })), 'E-MAN-08')
  })
})

describe('贡献上限与形状（E-MAN-09）', () => {
  it('themes 超过 6 项 → E-MAN-09', () => {
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            const themes = (m.contributes as { themes: Array<Record<string, unknown>> }).themes
            const template = themes[0]
            ;(m.contributes as Record<string, unknown>).themes = Array.from({ length: 7 }, (_, index) => ({
              ...template,
              id: `theme-${index}`,
            }))
          }),
        ),
      'E-MAN-09',
    )
  })

  it('覆盖内置主题 id → E-MAN-09；颜色非法 → E-MAN-09', () => {
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            ;((m.contributes as { themes: Array<Record<string, unknown>> }).themes[0]).id = 'noir'
          }),
        ),
      'E-MAN-09',
    )
    expectCode(
      () =>
        parseManifest(
          patch((m) => {
            ;((m.contributes as { themes: Array<Record<string, unknown>> }).themes[0].colors as Record<string, string>).bg = 'notacolor'
          }),
        ),
      'E-MAN-09',
    )
  })

  it('i18n 键集 zh/en 不等 → E-MAN-09；键非法 → E-MAN-09；合法通过', () => {
    const withLocale = (zh: Record<string, string>, en: Record<string, string>) =>
      patch((m) => {
        m.capabilities = ['theme:contribute', 'i18n:contribute']
        ;(m.contributes as Record<string, unknown>).i18n = [{ zh, en }]
      })
    expectCode(() => parseManifest(withLocale({ a: 'x' }, { b: 'y' })), 'E-MAN-09')
    expectCode(() => parseManifest(withLocale({ 'Bad Key': 'x' }, { 'Bad Key': 'y' })), 'E-MAN-09')
    expect(() => parseManifest(withLocale({ hello: '你好' }, { hello: 'Hello' }))).not.toThrow()
  })

  it('keymap 裸键 → E-MAN-09；合法组合通过；declarative 未声明命令 → E-MAN-09', () => {
    expect(isValidKeymapCombo('mod+shift+k')).toBe(true)
    expect(isValidKeymapCombo('mod+z')).toBe(true)
    expect(isValidKeymapCombo('shift+arrowup')).toBe(true)
    expect(isValidKeymapCombo('k')).toBe(false)
    expect(isValidKeymapCombo('f13')).toBe(false)

    const keymap = (combo: string) =>
      patch((m) => {
        m.capabilities = ['theme:contribute', 'ui:keymap']
        ;(m.contributes as Record<string, unknown>).keymap = [{ combo, commandId: 'go' }]
      })
    expectCode(() => parseManifest(keymap('k')), 'E-MAN-09')
    expectCode(() => parseManifest(keymap('mod+k')), 'E-MAN-09')
  })

  it('插槽 kind 与 slot 不匹配 / inline 无 open / open 指向未声明 → E-MAN-09', () => {
    const withSlots = (slots: unknown[]) =>
      patch((m) => {
        m.kind = 'code'
        m.entry = 'plugin.js'
        m.capabilities = ['ui:slot']
        ;(m.contributes as Record<string, unknown>).themes = undefined
        ;(m.contributes as Record<string, unknown>).slots = slots
      })
    const files = { 'plugin.js': CLEAN_SOURCE }
    expectCode(
      () => parseManifest(withSlots([{ id: 'aa', slot: 'workspace.topbar', title: { zh: 'A', en: 'A' }, kind: 'panel' }]), { files }),
      'E-MAN-09',
    )
    expectCode(
      () => parseManifest(withSlots([{ id: 'aa', slot: 'workspace.topbar', title: { zh: 'A', en: 'A' }, kind: 'inline' }]), { files }),
      'E-MAN-09',
    )
    expectCode(
      () =>
        parseManifest(
          withSlots([
            {
              id: 'aa',
              slot: 'workspace.topbar',
              title: { zh: 'A', en: 'A' },
              kind: 'inline',
              open: { slot: 'dialog', contributionId: 'missing' },
            },
          ]),
          { files },
        ),
      'E-MAN-09',
    )
  })

  it('带帧插槽超过 2 个 → E-MAN-09', () => {
    const framed = ['workspace.dock', 'workspace.overlay', 'dialog'].map((slot, index) => ({
      id: `frame-${index}`,
      slot,
      title: { zh: '面板', en: 'Panel' },
      kind: slot === 'dialog' ? 'modal' : 'panel',
    }))
    expectCode(
      () =>
        parseManifest(
          {
            ...codeManifest(),
            contributes: { slots: framed },
          },
          { files: { 'plugin.js': CLEAN_SOURCE } },
        ),
      'E-MAN-09',
    )
  })

  it('声明式命令 setTheme 引用未声明主题 → E-MAN-09；合法命令通过', () => {
    const withCommand = (command: Record<string, unknown>) =>
      patch((m) => {
        m.capabilities = ['theme:contribute', 'ui:command']
        ;(m.contributes as Record<string, unknown>).commands = [
          { id: 'apply', title: { zh: '应用', en: 'Apply' }, category: 'plugin', ...command },
        ]
      })
    expectCode(() => parseManifest(withCommand({ action: { kind: 'setTheme', themeId: 'missing' } })), 'E-MAN-09')
    expect(() => parseManifest(withCommand({ action: { kind: 'setTheme', themeId: 'sepia' } }))).not.toThrow()
    expect(() => parseManifest(withCommand({ action: { kind: 'toast', message: { zh: '好', en: 'OK' } } }))).not.toThrow()
  })

  it('图标非 svg / 缺失 / 净化失败 → E-MAN-11；带脚本的图标被净化后接受', () => {
    const withIcon = (icon: string) => patch((m) => { m.icon = icon })
    expectCode(() => parseManifest(withIcon('icon.png')), 'E-MAN-11')
    expectCode(() => parseManifest(withIcon('icon.svg'), { files: {} }), 'E-MAN-11')
    expectCode(() => parseManifest(withIcon('icon.svg'), { files: { 'icon.svg': 'not an svg at all' } }), 'E-MAN-11')
    expect(() =>
      parseManifest(withIcon('icon.svg'), {
        files: { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg>' },
      }),
    ).not.toThrow()
    // 带 <script> 的图标：sanitizeSvgDocument 会净化脚本而不是拒绝（02 §2.2）
    expect(() =>
      parseManifest(withIcon('icon.svg'), {
        files: { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>' },
      }),
    ).not.toThrow()
  })
})

describe('入口源码静态预检（03 §6.3，E-MAN-12）', () => {
  it('禁用 API 命中 → E-MAN-12', () => {
    for (const source of [
      'fetch("https://evil")',
      'const x = new Function("return 1")',
      'localStorage.setItem("a", "b")',
      'import { x } from "./x.js"',
      'const y = import("./y.js")',
      'window.open("https://evil")',
      'document.cookie = "a=1"',
      'new WebSocket("wss://evil")',
      'new Worker("./w.js")',
      '<script>alert(1)</script>',
    ]) {
      expectCode(() => parseManifest(codeManifest(), { files: { 'plugin.js': source } }), 'E-MAN-12')
    }
  })

  it('scanSource 返回命中细节（name/line/column）', () => {
    const hits = scanSource('const a = 1\nfetch("x")\n')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].name).toBe('fetch')
    expect(hits[0].line).toBe(2)
    expect(hits[0].column).toBe(1)
  })

  it('干净源码通过', () => {
    expect(() => assertSourceSafe(CLEAN_SOURCE, 'plugin.js')).not.toThrow()
  })
})

describe('parseManifest 返回类型', () => {
  it('可选字段按出现与否保留（不补 undefined 键）', () => {
    const manifest: PluginManifest = parseManifest(base())
    expect('entry' in manifest).toBe(false)
    expect('icon' in manifest).toBe(false)
    expect('trust' in manifest).toBe(false)
  })
})
