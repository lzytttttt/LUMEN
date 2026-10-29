/**
 * json-repair.test.ts —— 截断 JSON 的兜底修补。
 *
 * `none` 降级模式下模型可能不吐结构化输出（尾截断、markdown 围栏），
 * 这里确保 closeTruncatedJson 只修"差一点就能解析"的文本，修不好一律 null。
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeTruncatedJson, parseWithRepair } from '@/ai/validate'

describe('closeTruncatedJson', () => {
  it('补齐未闭合对象与数组', () => {
    expect(closeTruncatedJson('{"a":1')).toBe('{"a":1}')
    expect(closeTruncatedJson('{"a":[1,2')).toBe('{"a":[1,2]}')
    expect(JSON.parse(closeTruncatedJson('{"a":[{"b":2')!)).toEqual({ a: [{ b: 2 }] })
  })

  it('补齐未闭合字符串（含转义）', () => {
    expect(JSON.parse(closeTruncatedJson('{"text":"ab')!)).toEqual({ text: 'ab' })
    expect(JSON.parse(closeTruncatedJson('{"text":"a\\"')!)).toEqual({ text: 'a"' })
  })

  it('去掉悬空逗号、补悬空冒号的值', () => {
    expect(JSON.parse(closeTruncatedJson('{"a":1,')!)).toEqual({ a: 1 })
    expect(JSON.parse(closeTruncatedJson('{"a":')!)).toEqual({ a: null })
  })

  it('修不好就返回 null', () => {
    expect(closeTruncatedJson('not json at all')).toBeNull()
    expect(closeTruncatedJson('{"a"')).toBeNull()
  })
})

describe('parseWithRepair: 截断兜底', () => {
  it('模型尾部截断时仍能通过 schema', async () => {
    const schema = z.object({ title: z.string(), count: z.number() })
    await expect(parseWithRepair(schema, '{"title":"LUMEN","count":3')).resolves.toEqual({
      title: 'LUMEN',
      count: 3,
    })
  })

  it('围栏 + 截断组合仍能解析', async () => {
    const schema = z.object({ ok: z.boolean() })
    await expect(parseWithRepair(schema, '```json\n{"ok":true\n```')).resolves.toEqual({ ok: true })
  })
})
