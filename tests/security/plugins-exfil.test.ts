/**
 * tests/security/plugins-exfil.test.ts —— 红队 S-40-04（偷 AI key / 端点）与 S-40-05（外链请求）。
 *
 * 纯逻辑层可测：`redact()` 的脱敏规则、错误文案 key 表不含敏感串、public 门面不暴露 provider/密钥。
 * 帧内返回值与网络零出站必须在真实浏览器验证（Task-9 接线后并入 e2e `plugins-safe.spec.ts`）。
 */
import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGE_KEYS, redact } from '@/plugins/errors'
import * as publicFacade from '@/plugins/public'
import { PLUGIN_ERROR_CODES } from '@/plugins/types'
import { FORBIDDEN_FRAME_KEYS } from './security-testkit'

/** 典型密钥/端点形态（不得出现在任何可回传插件的文本里）。 */
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/i,
  /[?&](?:key|token|api_key|apikey|access_token)=[^&\s#***]+/i,
  /https?:\/\/[^\s?#]+\?[^\s#]*[A-Za-z0-9_-]{4,}/i,
]

function expectNoSecrets(text: string, label: string): void {
  for (const shape of SECRET_SHAPES) {
    expect(shape.test(text), `${label} 泄漏密钥形态：${shape}`).toBe(false)
  }
}

describe('S-40-04 密钥/端点不出宿主边界（纯逻辑）', () => {
  it('redact() 命中四类密钥形态后输出不含原文', () => {
    const raw =
      'key=sk-abcdefgh12345678 Authorization: Bearer abcdefgh.ijklmnop ' +
      'https://api.example.com/v1?api_key=abcdef&token=xyz 正常中文文案'
    const redacted = redact(raw)
    expectNoSecrets(redacted, 'redact()')
    expect(redacted).toContain('sk-***')
    expect(redacted).toContain('Bearer ***')
    expect(redacted).toContain('正常中文文案')
  })

  it('45 个错误码的用户文案 key 不含实现词/密钥形态（02 §5.5 + 06 §6.3）', () => {
    for (const code of PLUGIN_ERROR_CODES) {
      const key = ERROR_MESSAGE_KEYS[code]
      if (code === 'E-AUDIT-01') {
        // 02 §5.5：审计写入失败不提示（唯一空 key）
        expect(key, 'E-AUDIT-01 应为空 key（不提示）').toBe('')
        continue
      }
      expect(key, `${code} 缺少文案 key`).toBeTruthy()
      expect(key).toMatch(/^plugin\./)
      expectNoSecrets(key, `${code} → ${key}`)
      for (const forbidden of ['沙箱', 'RPC', '令牌', 'iframe', 'sandbox']) {
        expect(key.toLowerCase()).not.toContain(forbidden.toLowerCase())
      }
    }
  })

  it('public 门面只暴露 UI/安装门面，不导出 provider / 密钥 / 裸 fetch 通道', () => {
    const exported = Object.keys(publicFacade)
    for (const forbidden of FORBIDDEN_FRAME_KEYS) {
      expect(exported, `public 门面不应导出 ${forbidden}`).not.toContain(forbidden)
    }
    for (const name of exported) {
      expect(/^(getApiKey|readApiKey|apiKey|providerClient|fetchModel|rawFetch)$/i.test(name), `public 导出 ${name}`).toBe(false)
    }
  })

  it('错误消息默认脱敏：PluginError.detail 落审计前已 redact 且 ≤200 字符', async () => {
    const { PluginError } = await import('@/plugins/errors')
    const error = new PluginError('E-NET-01', 'fetch failed', 'sk-abcdefgh12345678 Bearer abcdefgh.ijklmnop https://x.test/?token=abc')
    expect(error.detail).toBeTruthy()
    expectNoSecrets(error.detail!, 'PluginError.detail')
    expect(error.detail!.length).toBeLessThanOrEqual(200)
  })
})

describe.todo('S-40-05 零出站请求（待 host/CSP 落地后并入浏览器 e2e）')
// 待补断言（03 §7 / 06 §4.3）：
// 1) 帧内 fetch / WebSocket / sendBeacon / <img src=https> / @import https 全部被 CSP 拦截；
// 2) Playwright page.route('**', abort) 计数：安装→启用→交互全过程首批资源外**零请求**；
// 3) 帧 console 出现 CSP violation 不计入 console error 白名单；
// 4) 导出独立 HTML 的 STANDALONE_CSP 不含 connect-src 外网来源（S-40-12）。
