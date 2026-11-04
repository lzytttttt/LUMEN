/**
 * tests/security/plugins-escape.test.ts —— 红队 S-40-01（逃逸读父页 DOM）/ S-40-06（帧内持久化绕过）。
 *
 * 这两类的**真实**证明必须在浏览器里（不透明源 iframe，见 03 §4.2）：
 * 位置在 `tests/e2e/plugins-safe.spec.ts`（Task-9 联调时补注入脚本 + 宿主 DOM 快照对比）。
 * 本文件保留纯逻辑层可验证的防线：帧文档 CSP 配置形状、boot 注入对象不含宿主句柄。
 * frameDoc.ts 落地前用 todo 占位。
 */
import { describe, expect, it } from 'vitest'
import { FrameBootPayloadKeysForTest } from './security-testkit'

describe('S-40-01 / S-40-06 宿主侧防线（纯逻辑）', () => {
  it('boot 注入只含帧需要的元数据，不含 window/document 句柄或密钥（03 §4.3）', () => {
    const allowed = new Set(FrameBootPayloadKeysForTest)
    expect([...allowed].sort()).toEqual(
      ['apiVersion', 'appVersion', 'capabilities', 'entryPath', 'frameNonce', 'locale', 'pluginId', 'pluginVersion', 'tokens'].sort(),
    )
    for (const key of allowed) {
      expect(['window', 'document', 'parent', 'top', 'opener', 'cryptoKey', 'apiKey', 'token']).not.toContain(key)
    }
  })

  it('帧协议常量：消息 ≤64KB、深度 ≤8、请求超时 8s（02 §4.4，逃逸载荷不能靠超大消息）', async () => {
    const types = await import('@/plugins/types')
    expect(types.FRAME_MESSAGE_MAX_BYTES).toBe(64 * 1024)
    expect(types.FRAME_MESSAGE_MAX_DEPTH).toBe(8)
    expect(types.FRAME_REQUEST_TIMEOUT_MS).toBe(8000)
    expect(types.FRAME_PROTOCOL_VERSION).toBe(1)
  })
})

describe.todo('S-40-01 / S-40-06 真实沙箱（浏览器 e2e `tests/e2e/plugins-safe.spec.ts`）')
// 待补断言：
// 1) S-40-01：帧内 `parent.document` / `top.document` / `window.parent.location.href`
//    抛 SecurityError（不透明源），宿主页面 DOM 快照前后一致、无数据泄漏；
// 2) S-40-06：帧内 `localStorage.setItem` / `indexedDB.open` / `document.cookie=` 抛错或无效，
//    宿主 `localStorage.length` 与 IDB 库列表不变，唯一通路是 `lumen.storage`；
// 3) 帧 srcdoc 的 CSP 串与 03 §4.3 逐字一致（connect-src 'none' / worker-src 'none' / 无 unsafe-eval）。
