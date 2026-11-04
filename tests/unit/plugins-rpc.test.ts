/**
 * tests/unit/plugins-rpc.test.ts —— 帧协议 / 沙箱帧文档 / bootstrap / 看门狗（06 §5 唯一放宽：假帧 + 假 postMessage 总线）。
 *
 * 覆盖（U-40 的协议面）：
 * - 帧格式校验：source 主判据 / pluginId+nonce 身份 / v / type / id / 64KB / 深度 8；
 * - 限流：120 msg/s（burst 240）、256KB/s、同一帧 10 次拒绝/分钟 → 挂起；
 * - 请求匹配：宿主 → 帧 `h<n>` 8s 超时、在飞 ≤32、未知 id 丢弃；
 * - 帧文档：PLUGIN_CSP 逐字、srcdoc 结构、`</script` 转义、SRC 内联、无外部 script src；
 * - bootstrap：17 命名空间、`__ready`/`__error`/心跳回包、window.lumen 冻结；
 * - 看门狗：2500ms ready 超时、4000ms×3 心跳、帧配额（8 / 2 / 1）、连续失败 3 次隔离判定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FRAME_ID_PATTERN,
  FrameRateLimiter,
  HostRpcChannel,
  RequestTracker,
  TokenBucket,
  ThroughputWindow,
  checkFrameMessage,
  createFrameNonce,
  messageByteSize,
  valueDepth,
} from '@/plugins/host/rpc'
import {
  FRAME_CSS_MAX_BYTES,
  PLUGIN_CSP,
  collectFrameTokens,
  composeBootData,
  composeFrameDoc,
  tokensCss,
  validateFrameDoc,
  PLUGIN_EVALUATED_SENTINEL,
  type FrameDocInput,
} from '@/plugins/host/frameDoc'
import { composeBootstrapScript, validateBootstrapSource } from '@/plugins/host/inject'
import { BootFailureTracker, FrameQuota, FrameWatchdog } from '@/plugins/host/watchdog'
import type { FrameMessage } from '@/plugins/types'

/* ------------------------------ 夹具 ------------------------------ */

const IDENTITY = { pluginId: 'com.example.demo', frameNonce: 'a'.repeat(32) }
const CONTENT_WINDOW = { name: 'frame-window' }

function frameInput(overrides: Partial<FrameDocInput> = {}): FrameDocInput {
  return {
    pluginId: IDENTITY.pluginId,
    pluginKind: 'code',
    pluginVersion: '1.0.0',
    apiVersion: '1.0',
    appVersion: '0.4.0',
    slot: 'workspace.dock',
    contributionId: 'dock',
    title: 'Demo',
    frameNonce: IDENTITY.frameNonce,
    entryPath: 'plugin.js',
    entrySource: 'const lumen = window.lumen; lumen.log.info("hi")',
    locale: 'zh',
    lang: 'zh',
    uiTheme: 'dark',
    reducedMotion: false,
    density: 'comfortable',
    capabilities: ['ui:slot', 'deck:read'],
    tokens: { '--d-bg': '#0a0b0e', '--ui-fg': '#e8eaef' },
    localePack: { zh: { 'panel.title': '示例' }, en: { 'panel.title': 'Demo' } },
    bootstrap: composeBootstrapScript(),
    ...overrides,
  }
}

function message(overrides: Partial<FrameMessage> = {}): FrameMessage {
  return {
    v: 1,
    id: 'f1',
    type: 'req',
    pluginId: IDENTITY.pluginId,
    frameNonce: IDENTITY.frameNonce,
    method: 'deck.getSnapshot',
    payload: {},
    ...overrides,
  }
}

const META = { source: CONTENT_WINDOW, contentWindow: CONTENT_WINDOW, origin: 'null' }

/* ------------------------------ 帧格式 ------------------------------ */

describe('帧格式校验（02 §4.4 S-40-02）', () => {
  it('合法帧通过，返回同一对象', () => {
    const data = message()
    const result = checkFrameMessage(data, IDENTITY, META)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.message).toBe(data)
  })

  it('来源不是本帧 contentWindow → source 拒绝（主判据）', () => {
    const result = checkFrameMessage(message(), IDENTITY, { source: {}, contentWindow: CONTENT_WINDOW })
    expect(result).toEqual({ ok: false, reason: 'source' })
  })

  it('错 nonce / 冒充其他 pluginId → identity 拒绝', () => {
    expect(checkFrameMessage(message({ frameNonce: 'b'.repeat(32) }), IDENTITY, META).ok).toBe(false)
    const forged = checkFrameMessage(message({ pluginId: 'com.example.other' }), IDENTITY, META)
    expect(forged).toEqual({ ok: false, reason: 'identity' })
  })

  it('v/type/id 不合法一律丢弃', () => {
    expect(checkFrameMessage({ ...message(), v: 2 }, IDENTITY, META).ok).toBe(false)
    expect(checkFrameMessage({ ...message(), type: 'hello' as never }, IDENTITY, META).ok).toBe(false)
    expect(checkFrameMessage({ ...message(), id: 'x1' }, IDENTITY, META).ok).toBe(false)
    expect(checkFrameMessage(null, IDENTITY, META).ok).toBe(false)
  })

  it('id 形状：插件 f<n>，宿主 h<n>', () => {
    expect(FRAME_ID_PATTERN.test('f0')).toBe(true)
    expect(FRAME_ID_PATTERN.test('h42')).toBe(true)
    expect(FRAME_ID_PATTERN.test('f-1')).toBe(false)
    expect(FRAME_ID_PATTERN.test('x9')).toBe(false)
  })

  it('evt 通知可缺省 id（__log/__ready/__pong），req/res/err 必须有 id', () => {
    const ready = { v: 1, type: 'evt', pluginId: IDENTITY.pluginId, frameNonce: IDENTITY.frameNonce, method: '__ready' } as unknown
    expect(checkFrameMessage(ready, IDENTITY, META).ok).toBe(true)
    const logEvent = { v: 1, id: undefined, type: 'evt', pluginId: IDENTITY.pluginId, frameNonce: IDENTITY.frameNonce, method: '__log' }
    expect(checkFrameMessage(logEvent, IDENTITY, META).ok).toBe(true)
    const reqWithoutId = { v: 1, type: 'req', pluginId: IDENTITY.pluginId, frameNonce: IDENTITY.frameNonce, method: 'deck.getSnapshot' }
    expect(checkFrameMessage(reqWithoutId, IDENTITY, META)).toEqual({ ok: false, reason: 'id' })
    const resWithoutId = { v: 1, type: 'res', pluginId: IDENTITY.pluginId, frameNonce: IDENTITY.frameNonce }
    expect(checkFrameMessage(resWithoutId, IDENTITY, META)).toEqual({ ok: false, reason: 'id' })
  })

  it('单条 >64KB → E-ABI-03', () => {
    const big = message({ payload: { text: 'x'.repeat(70 * 1024) } })
    const result = checkFrameMessage(big, IDENTITY, META)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('E-ABI-03')
  })

  it('深度 >8 → E-ABI-03', () => {
    let deep: unknown = 'leaf'
    for (let index = 0; index < 12; index += 1) deep = { nested: deep }
    const result = checkFrameMessage(message({ payload: deep }), IDENTITY, META)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('E-ABI-03')
    expect(valueDepth(deep)).toBeGreaterThan(8)
    expect(valueDepth({ a: [1, 2, { b: 3 }] })).toBeLessThanOrEqual(4)
  })

  it('循环引用不抛错且判为超深/不可序列化', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(valueDepth(loop)).toBe(Number.POSITIVE_INFINITY)
    expect(messageByteSize(loop)).toBe(Number.POSITIVE_INFINITY)
  })

  it('nonce 为 32 hex', () => {
    expect(createFrameNonce()).toMatch(/^[0-9a-f]{32}$/)
    expect(createFrameNonce(() => 0)).toBe('0'.repeat(32))
  })
})

/* ------------------------------ 限流 ------------------------------ */

describe('限流与配额（02 §4.5）', () => {
  it('令牌桶：120/s burst 240', () => {
    const now = vi.fn(() => 0)
    const bucket = new TokenBucket(120, 240, now)
    for (let index = 0; index < 240; index += 1) expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
    now.mockReturnValue(1000)
    expect(bucket.tryTake()).toBe(true)
  })

  it('吞吐窗口：256KB/s', () => {
    const now = vi.fn(() => 0)
    const window = new ThroughputWindow(256 * 1024, now)
    expect(window.tryTake(200 * 1024)).toBe(true)
    expect(window.tryTake(100 * 1024)).toBe(false)
    now.mockReturnValue(1500)
    expect(window.tryTake(100 * 1024)).toBe(true)
  })

  it('同一帧 10 次拒绝/分钟 → 挂起（E-ABI-04）', () => {
    const now = vi.fn(() => 1000)
    const limiter = new FrameRateLimiter(now)
    for (let index = 0; index < 9; index += 1) expect(limiter.noteRejection()).toBe(false)
    expect(limiter.noteRejection()).toBe(true)
    expect(limiter.isSuspended).toBe(true)
    expect(limiter.tryConsume(1)).toBe('E-ABI-04')
  })

  it('超速请求回 E-ABI-04', () => {
    const now = vi.fn(() => 0)
    const limiter = new FrameRateLimiter(now)
    let blocked = 0
    for (let index = 0; index < 300; index += 1) if (limiter.tryConsume(100) !== null) blocked += 1
    expect(blocked).toBeGreaterThan(0)
  })
})

/* ------------------------------ 请求匹配 ------------------------------ */

describe('请求匹配与超时（02 §4.4）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('宿主 → 帧请求 id 为 h<n>，8s 超时 → E-ABI-05', async () => {
    const tracker = new RequestTracker()
    const { request, promise } = tracker.create('ui.setTitle')
    expect(request.id).toBe('h1')
    expect(tracker.size).toBe(1)
    vi.advanceTimersByTime(8000)
    await expect(promise).rejects.toMatchObject({ code: 'E-ABI-05' })
    expect(tracker.size).toBe(0)
  })

  it('res 匹配后清计时器；未知 id 返回 false（后到者丢弃）', async () => {
    const tracker = new RequestTracker()
    const { request, promise } = tracker.create('deck.getSnapshot')
    expect(tracker.settle(request.id, true, { ok: 1 })).toBe(true)
    await expect(promise).resolves.toEqual({ ok: 1 })
    expect(tracker.settle(request.id, true, null)).toBe(false)
    expect(tracker.settle('h999', true, null)).toBe(false)
  })

  it('在飞请求 ≤32：超限立即 E-ABI-04', async () => {
    const tracker = new RequestTracker()
    for (let index = 0; index < 32; index += 1) tracker.create('deck.getSnapshot')
    const { promise } = tracker.create('deck.getSnapshot')
    await expect(promise).rejects.toMatchObject({ code: 'E-ABI-04' })
  })

  it('dispose 时全部 reject', async () => {
    const tracker = new RequestTracker()
    const { promise } = tracker.create('theme.get')
    tracker.rejectAll(new Error('frame disposed'))
    await expect(promise).rejects.toThrow('frame disposed')
  })
})

/* ------------------------------ HostRpcChannel ------------------------------ */

describe('HostRpcChannel（假帧 + 假 postMessage 总线）', () => {
  function createChannel(overrides: { onRequest?: (method: string, payload: unknown) => Promise<unknown> } = {}) {
    const posted: FrameMessage[] = []
    const onEvent = vi.fn()
    const onRejected = vi.fn()
    const channel = new HostRpcChannel({
      identity: IDENTITY,
      post: (out) => posted.push(out),
      onRequest: overrides.onRequest ?? (async () => ({ ok: true })),
      onEvent,
      onRejected,
    })
    return { channel, posted, onEvent, onRejected }
  }

  it('req → onRequest → res（同 id）', async () => {
    const { channel, posted } = createChannel()
    channel.handle(message({ method: 'deck.getSnapshot' }), META)
    await vi.waitFor(() => expect(posted.some((out) => out.type === 'res' && out.id === 'f1')).toBe(true))
    const response = posted.find((out) => out.type === 'res')!
    expect(response.payload).toEqual({ ok: true })
  })

  it('handler 抛错 → err 帧（code 保留）', async () => {
    const { channel, posted } = createChannel({
      onRequest: async () => {
        const error = new Error('nope') as Error & { code?: string }
        error.code = 'E-CAP-01'
        throw error
      },
    })
    channel.handle(message({ method: 'deck.insertBlocks' }), META)
    await vi.waitFor(() => expect(posted.some((out) => out.type === 'err')).toBe(true))
    const response = posted.find((out) => out.type === 'err')!
    expect(response.code).toBe('E-CAP-01')
    expect(response.message).toBe('nope')
  })

  it('来源不符 → onRejected(source)，不回应', () => {
    const { channel, posted, onRejected } = createChannel()
    channel.handle(message(), { source: {}, contentWindow: CONTENT_WINDOW })
    expect(onRejected).toHaveBeenCalledWith('source')
    expect(posted).toHaveLength(0)
  })

  it('evt 事件路由到 onEvent', () => {
    const { channel, onEvent } = createChannel()
    channel.handle(message({ id: 'f2', type: 'evt', method: '__pong', payload: { at: 1 } }), META)
    expect(onEvent).toHaveBeenCalledWith('__pong', { at: 1 })
  })

  it('宿主发起请求：post 出 h<n>，收到 res 后 resolve', async () => {
    const { channel, posted } = createChannel()
    const pending = channel.request('ui.setTitle', { title: 'hi' })
    const outbound = posted.find((out) => out.type === 'req')!
    expect(outbound.id).toMatch(/^h\d+$/)
    channel.handle(message({ id: outbound.id, type: 'res', payload: null }), META)
    await expect(pending).resolves.toBeNull()
  })
})

/* ------------------------------ 帧文档 ------------------------------ */

describe('srcdoc 拼装（02 §4.2）', () => {
  it('PLUGIN_CSP 逐字冻结', () => {
    expect(PLUGIN_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        'img-src data: blob:; font-src data:; media-src data: blob:; ' +
        "connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'",
    )
    expect(PLUGIN_CSP).not.toContain("'unsafe-eval'")
    expect(PLUGIN_CSP).not.toContain('blob:; script')
  })

  it('文档结构逐项存在且自检通过', () => {
    const html = composeFrameDoc(frameInput())
    expect(validateFrameDoc(html)).toEqual([])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('data-plugin-id="com.example.demo"')
    expect(html).toContain('data-plugin-slot="workspace.dock"')
    expect(html).toContain('id="lumen-root"')
    expect(html).toContain('id="lumen-tokens"')
    expect(html).toContain('id="lumen-sdk"')
    expect(html).toContain('id="lumen-boot"')
    expect(html).toContain('type="module" id="lumen-plugin"')
    expect(html).toContain('data-entry="plugin.js"')
    expect(html).toContain(PLUGIN_EVALUATED_SENTINEL.trim())
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toContain("'unsafe-eval'")
  })

  it('插件源码里的 </script 被转义，不提前闭合标签', () => {
    const html = composeFrameDoc(frameInput({ entrySource: 'const s = "</script><script>alert(1)</script>"' }))
    const pluginTagStart = html.indexOf('id="lumen-plugin"')
    const bodyAfter = html.slice(pluginTagStart)
    // 源码中的 </script 已变成 <\/script（\x3c? escapeScriptText 只处理 </script）
    expect(bodyAfter).toContain('<\\/script>')
    expect(bodyAfter.match(/<\/script>/g)?.length).toBe(1)
  })

  it('boot payload 内联 JSON 不含裸 </script>', () => {
    const html = composeFrameDoc(frameInput({ title: '</script><script>alert(1)</script>' }))
    expect(html).not.toContain('__LUMEN_BOOT__={};')
    const bootIndex = html.indexOf('__LUMEN_BOOT__=')
    const scriptClose = html.indexOf('</script>', bootIndex)
    const segment = html.slice(bootIndex, scriptClose)
    expect(segment).not.toContain('<script>')
    expect(segment).toContain('\\u003c')
  })

  it('boot payload 含 locale/capabilities/nonce/entryPath 且不含 grants', () => {
    const data = composeBootData(frameInput())
    expect(data.pluginId).toBe(IDENTITY.pluginId)
    expect(data.frameNonce).toBe(IDENTITY.frameNonce)
    expect(data.capabilities).toEqual(['ui:slot', 'deck:read'])
    expect(data.entryPath).toBe('plugin.js')
    expect(data.i18n.zh['panel.title']).toBe('示例')
    expect(JSON.stringify(data)).not.toContain('grants')
    expect(JSON.stringify(data)).not.toContain('apiKey')
  })

  it('reduced-motion / uiTheme / density 进入 html 属性', () => {
    const html = composeFrameDoc(frameInput({ uiTheme: 'light', reducedMotion: true, density: 'compact' }))
    expect(html).toContain('data-ui-theme="light"')
    expect(html).toContain('data-reduced-motion="true"')
    expect(html).toContain('data-density="compact"')
  })

  it('令牌快照只收合法 CSS 变量名', () => {
    expect(tokensCss({ '--d-bg': '#000', 'bad': 'x', '--x': '  ' })).toBe(':root{--d-bg:#000;}')
  })

  it('collectFrameTokens 在非浏览器环境返回主题变量', () => {
    const tokens = collectFrameTokens('noir')
    expect(tokens['--d-bg']).toBeTruthy()
    expect(tokens['--d-accent']).toBeTruthy()
  })

  it('validateFrameDoc 能发现缺失 CSP/外部脚本', () => {
    expect(validateFrameDoc('<!doctype html><html></html>')).not.toEqual([])
    const html = composeFrameDoc(frameInput())
    expect(validateFrameDoc(html)).toEqual([])
    expect(FRAME_CSS_MAX_BYTES).toBe(64 * 1024)
  })
})

/* ------------------------------ bootstrap ------------------------------ */

describe('bootstrap 客户端（02 §4.3 / §5.3）', () => {
  const source = composeBootstrapScript()

  it('自检通过：17 命名空间 + ready/error/心跳', () => {
    expect(validateBootstrapSource(source)).toEqual([])
    for (const name of [
      'meta',
      'ui',
      'commands',
      'keymap',
      'layout',
      'deck',
      'theme',
      'storage',
      'settings',
      'i18n',
      'lint',
      'ai',
      'assets',
      'export',
      'events',
      'notify',
      'log',
    ]) {
      expect(source).toContain(`lumen.${name} =`)
    }
    expect(source).toContain('__LUMEN_BOOT__')
    expect(source).toContain('__ready')
    expect(source).toContain('__error')
    expect(source).toContain('unhandledrejection')
    expect(source).toContain('Object.freeze(lumen)')
  })

  it('不包含 eval / new Function / fetch 直调（CSP 兜底之前的第一道）', () => {
    expect(source.includes('eval(')).toBe(false)
    expect(source.includes('new Function')).toBe(false)
    expect(source.includes('fetch(')).toBe(false)
    expect(source.includes('XMLHttpRequest')).toBe(false)
  })

  it('请求超时为 8000ms，且 ready 由宿主计时', () => {
    expect(source).toContain('var REQ_TIMEOUT = 8000;')
  })
})

/* ------------------------------ 看门狗 / 配额 ------------------------------ */

describe('看门狗与配额（02 §3.5 / §4.5）', () => {
  function fakeClock() {
    let timeouts: Array<{ id: number; fn: () => void; at: number; kind: 'timeout' }> = []
    let intervals: Array<{ id: number; fn: () => void; ms: number }> = []
    let seq = 0
    const clock = {
      setTimeout: (fn: () => void, ms: number) => {
        seq += 1
        timeouts.push({ id: seq, fn, at: Date.now() + ms, kind: 'timeout' })
        return seq as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => {
        timeouts = timeouts.filter((timer) => timer.id !== (id as unknown as number))
      },
      setInterval: (fn: () => void, ms: number) => {
        seq += 1
        intervals.push({ id: seq, fn, ms })
        return seq as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: (id: ReturnType<typeof setInterval>) => {
        intervals = intervals.filter((timer) => timer.id !== (id as unknown as number))
      },
      now: () => Date.now(),
    }
    return {
      clock,
      fireTimeouts: () => {
        const pending = timeouts
        timeouts = []
        for (const timer of pending) timer.fn()
      },
      tickIntervals: () => {
        for (const timer of intervals) timer.fn()
      },
    }
  }

  it('ready 2500ms 超时回调一次', () => {
    const { clock, fireTimeouts } = fakeClock()
    const onReadyTimeout = vi.fn()
    const watchdog = new FrameWatchdog({ clock, onReadyTimeout })
    watchdog.start()
    fireTimeouts()
    expect(onReadyTimeout).toHaveBeenCalledTimes(1)
    watchdog.stop()
  })

  it('markReady 后心跳：2 次 miss 只 ping，第 3 次 → onHung', () => {
    const { clock, tickIntervals } = fakeClock()
    const onHung = vi.fn()
    const onTick = vi.fn()
    const watchdog = new FrameWatchdog({ clock, onHung, onTick })
    watchdog.start()
    watchdog.markReady()
    tickIntervals()
    expect(onTick).toHaveBeenCalledTimes(1)
    tickIntervals()
    expect(onTick).toHaveBeenCalledTimes(2)
    tickIntervals()
    expect(onHung).toHaveBeenCalledWith(3)
    watchdog.stop()
  })

  it('pong 清零 miss', () => {
    const { clock, tickIntervals } = fakeClock()
    const onHung = vi.fn()
    const watchdog = new FrameWatchdog({ clock, onHung })
    watchdog.start()
    watchdog.markReady()
    tickIntervals()
    tickIntervals()
    watchdog.pong()
    expect(watchdog.missedBeats).toBe(0)
    tickIntervals()
    expect(onHung).not.toHaveBeenCalled()
  })

  it('帧配额：全局 8 / 每插件 2 / 草稿 1', () => {
    const quota = new FrameQuota()
    expect(quota.acquire('f1', 'p1').ok).toBe(true)
    expect(quota.acquire('f2', 'p1').ok).toBe(true)
    const third = quota.acquire('f3', 'p1')
    expect(third.ok).toBe(false)
    expect(third.code).toBe('E-QUOTA-04')
    for (let index = 0; index < 6; index += 1) expect(quota.acquire(`g${index}`, `q${index}`).ok).toBe(true)
    expect(quota.acquire('g8', 'q8')).toMatchObject({ ok: false, code: 'E-QUOTA-04' })
    expect(quota.total).toBe(8)
    quota.clear()
    expect(quota.acquire('d1', 'draft/abc', 'draft').ok).toBe(true)
    expect(quota.acquire('d2', 'draft/xyz', 'draft').ok).toBe(false)
  })

  it('连续失败 3 次 → quarantined，成功清零；自动重启仅 1 次', () => {
    const tracker = new BootFailureTracker()
    expect(tracker.fail('p').failureCount).toBe(1)
    expect(tracker.fail('p').failureCount).toBe(2)
    expect(tracker.fail('p')).toEqual({ failureCount: 3, quarantined: true })
    tracker.success('p')
    expect(tracker.count('p')).toBe(0)
    expect(tracker.allowAutoRestart('p')).toBe(true)
    expect(tracker.allowAutoRestart('p')).toBe(false)
  })
})
