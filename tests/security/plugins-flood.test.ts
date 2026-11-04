/**
 * tests/security/plugins-flood.test.ts —— 红队 S-40-11 DoS（体积/洪水/无限循环/帧自增）。
 *
 * 当前可测：包体积上限在任何解包前就拒绝（E-PKG-04，防 3MB 包打爆内存）；
 * 限流器（令牌桶 120/s）/ 帧配额（8 / 每插件 2）/ 看门狗需 src/plugins/host/** 落地后补。
 */
import { describe, expect, it } from 'vitest'
import { PACKAGE_LIMITS, buildEnvelope, parseEnvelope } from '@/plugins/package'
import { isPluginError } from '@/plugins/errors'
import type { PluginManifest } from '@/plugins/types'
import {
  FRAME_GLOBAL_LIMIT,
  FRAME_PER_PLUGIN_LIMIT,
  FRAME_RATE_BURST,
  FRAME_RATE_PER_SECOND,
  FRAME_REJECT_LIMIT_PER_MINUTE,
  FRAME_THROUGHPUT_BYTES_PER_SECOND,
} from '@/plugins/types'

const manifest: PluginManifest = {
  id: 'com.qatools.flood',
  name: { zh: '洪水夹具', en: 'Flood fixture' },
  version: '0.1.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'QA' },
  description: { zh: 'DoS 红队夹具。', en: 'DoS red-team fixture.' },
  license: 'MIT',
  capabilities: [],
  contributes: {},
}

describe('S-40-11 体积 DoS：超限包在解析/分配前拒绝', () => {
  it('3MB 文本包 → E-PKG-04（入口 maxBytes 先断流，不做 JSON.parse）', () => {
    const text = 'x'.repeat(3 * 1024 * 1024)
    try {
      parseEnvelope(text)
      throw new Error('3MB 包不应被接受')
    } catch (error) {
      expect(isPluginError(error), String(error)).toBe(true)
      expect((error as { code: string }).code).toBe('E-PKG-04')
    }
  })

  it('超限判定是 O(1) 字节数：2MB+1 字节即拒绝，不依赖 JSON 结构', () => {
    const text = 'x'.repeat(PACKAGE_LIMITS.maxBytes + 1)
    try {
      parseEnvelope(text)
      throw new Error('超 2MB 包不应被接受')
    } catch (error) {
      expect((error as { code: string }).code).toBe('E-PKG-04')
    }
  })

  it('包体积上限常量冻结为 2,000,000B / 64 文件 / 单文件 512KB / entry 256KB', () => {
    expect(PACKAGE_LIMITS).toMatchObject({
      maxBytes: 2_000_000,
      maxFiles: 64,
      maxFileBytes: 512_000,
      maxEntryBytes: 256_000,
    })
  })

  it('合法但接近上限的包仍能解析（上限不是 0 边界）', async () => {
    const envelope = await buildEnvelope({ manifest, files: { 'readme.md': 'x'.repeat(1000) }, createdAt: 1717200000000 })
    expect(() => parseEnvelope(JSON.stringify(envelope))).not.toThrow()
  })
})

describe('S-40-11 限流/帧配额常量（02 §4.5 冻结）', () => {
  it('令牌桶 120/s、突发 240、全局 8 帧、每插件 2 帧、拒绝 10 次/分、吞吐 256KB/s', () => {
    expect(FRAME_RATE_PER_SECOND).toBe(120)
    expect(FRAME_RATE_BURST).toBe(240)
    expect(FRAME_GLOBAL_LIMIT).toBe(8)
    expect(FRAME_PER_PLUGIN_LIMIT).toBe(2)
    expect(FRAME_REJECT_LIMIT_PER_MINUTE).toBe(10)
    expect(FRAME_THROUGHPUT_BYTES_PER_SECOND).toBe(256 * 1024)
  })
})

describe.todo('S-40-11 运行时（待 src/plugins/host/rpc.ts + watchdog.ts 落地）')
// 待补断言：
// 1) 5s 发 1 万条 req → 令牌桶拒绝 E-ABI-04，主线程不阻塞（rAF 采样）；
// 2) 看门狗：心跳 4s×3 丢失 → E-HOST-03 错误卡，帧挂起但宿主可恢复；
// 3) 第 9 个帧 → E-QUOTA-04；同插件第 3 个帧 → 拒绝；
// 4) 帧内 while(true)：iframe 独立线程，宿主 rAF 不掉帧，2500ms ready 超时 → 计数。
