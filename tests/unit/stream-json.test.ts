/**
 * stream-json.test.ts —— 增量字段流（`05` §4.7 + `07` L-05）。
 *
 * 覆盖：key 被切两半、转义 `\"`、`\u4e2d` 逐位到达、`points[2]` 跨 chunk、
 * 未闭合在 `end()` 丢弃、64KB 上限暂停、1e6 字符 < 20ms、嵌套同名 key 不触发。
 */
import { describe, expect, it } from 'vitest'
import { createFieldStreamer, FIELD_BUFFER_LIMIT } from '@/ai/streamJson'

interface Emission {
  key: string
  value: string
  final: boolean
}

function collect(keys: string[]): { streamer: ReturnType<typeof createFieldStreamer>; emits: Emission[] } {
  const emits: Emission[] = []
  const streamer = createFieldStreamer(keys, (key, value, final) => emits.push({ key, value, final }))
  return { streamer, emits }
}

function feed(streamer: ReturnType<typeof createFieldStreamer>, chunks: string[]): void {
  for (const chunk of chunks) streamer.push(chunk)
}

const finalOf = (emits: Emission[], key: string): string | undefined =>
  emits.filter((emit) => emit.key === key && emit.final).at(-1)?.value

describe('ai/streamJson', () => {
  it('key 被切成两半仍能识别', () => {
    const { streamer, emits } = collect(['headline'])
    feed(streamer, ['{"head', 'line":"慢', '就是快",', '"lead":"x"}'])
    streamer.end()
    expect(finalOf(emits, 'headline')).toBe('慢就是快')
    expect(finalOf(emits, 'lead')).toBeUndefined()
  })

  it('转义 \\" 与 \\n 被还原', () => {
    const { streamer, emits } = collect(['headline'])
    feed(streamer, ['{"headline":"他说\\"慢\\"，', '然后\\n停三秒"}'])
    streamer.end()
    expect(finalOf(emits, 'headline')).toBe('他说"慢"，然后\n停三秒')
  })

  it('\\u4e2d 逐位到达：四位未到齐不 emit，到齐后再发', () => {
    const { streamer, emits } = collect(['headline'])
    streamer.push('{"headline":"\\u4e')
    const partial = emits.filter((emit) => emit.key === 'headline' && !emit.final).map((emit) => emit.value)
    expect(partial.join('')).toBe('')
    streamer.push('2d')
    streamer.push('"}')
    streamer.end()
    expect(finalOf(emits, 'headline')).toBe('中')
  })

  it('数组字段逐条落位：points[2] 跨 chunk', () => {
    const { streamer, emits } = collect(['points'])
    feed(streamer, ['{"points":["甲","乙","丙', '丙"],"headline":"x"}'])
    streamer.end()
    expect(finalOf(emits, 'points[0]')).toBe('甲')
    expect(finalOf(emits, 'points[1]')).toBe('乙')
    expect(finalOf(emits, 'points[2]')).toBe('丙丙')
  })

  it('嵌套对象里的同名 key 不触发（只扫顶层）', () => {
    const { streamer, emits } = collect(['headline'])
    feed(streamer, ['{"visual":{"headline":"不该出现"},"headline":"该出现"}'])
    streamer.end()
    const finals = emits.filter((emit) => emit.key === 'headline' && emit.final).map((emit) => emit.value)
    expect(finals).toEqual(['该出现'])
  })

  it('未闭合在 end() 时以空值 + final:false 丢弃', () => {
    const { streamer, emits } = collect(['headline'])
    feed(streamer, ['{"headline":"写到一半'])
    streamer.end()
    expect(finalOf(emits, 'headline')).toBeUndefined()
    const last = emits.at(-1)
    expect(last).toEqual({ key: 'headline', value: '', final: false })
  })

  it('超 64KB 只保留尾 4KB 并暂停 emit', () => {
    const { streamer, emits } = collect(['headline'])
    const huge = 'x'.repeat(FIELD_BUFFER_LIMIT + 1024)
    streamer.push(`{"headline":"${huge}`)
    // 暂停后不再有任何前缀上屏。
    const countAfterLimit = emits.length
    streamer.push('y'.repeat(10_000))
    expect(emits.length).toBe(countAfterLimit)
    expect(emits.every((emit) => emit.value.length <= FIELD_BUFFER_LIMIT)).toBe(true)
    streamer.push('"}')
    streamer.end()
    expect(finalOf(emits, 'headline')).toBeUndefined()
  })

  it('1e6 字符单遍扫描 < 20ms', () => {
    const payload = `{"headline":"${'慢'.repeat(999_980)}"}`
    expect(payload.length).toBeGreaterThan(999_000)
    const { streamer } = collect(['headline'])
    const started = performance.now()
    // 切片长度故意取质数，避免按 key 边界对齐。
    for (let i = 0; i < payload.length; i += 997) streamer.push(payload.slice(i, i + 997))
    streamer.end()
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(20)
  })

  it('snapshot() 含未完成字段的最新前缀', () => {
    const { streamer } = collect(['headline'])
    streamer.push('{"headline":"慢慢')
    expect(streamer.snapshot().headline).toBe('慢慢')
  })
})
