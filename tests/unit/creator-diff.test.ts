/**
 * creator-diff.test.ts —— 行级 diff（`src/creator/text-diff.ts`）的验收。
 *
 * 覆盖 06 §4.1：U-40-185（diff 正反例/上下文/双列行号）、U-40-186（超限降级整文件替换）。
 * 额外加一组「应用 hunk 可重建新文件」的性质测试，防止 Myers 实现回退时假绿。
 */
import { describe, expect, it } from 'vitest'
import {
  DIFF_MAX_FILE_LINES,
  diffFileTrees,
  diffLines,
  hunkHeader,
  splitLines,
  type DiffHunk,
} from '@/creator/text-diff'

/** 校验 hunk 行号自洽 + 可用它重建新文件。 */
function applyHunks(before: string, hunks: DiffHunk[]): string {
  const oldLines = splitLines(before)
  const out: string[] = []
  let cursor = 0 // 0-based 旧文件游标
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    while (cursor < start) {
      out.push(oldLines[cursor])
      cursor += 1
    }
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        expect(line.oldLine).toBe(cursor + 1)
        out.push(line.text)
        cursor += 1
      } else if (line.kind === 'remove') {
        expect(line.oldLine).toBe(cursor + 1)
        cursor += 1
      } else {
        expect(line.newLine).not.toBeNull()
        out.push(line.text)
      }
    }
  }
  while (cursor < oldLines.length) {
    out.push(oldLines[cursor])
    cursor += 1
  }
  return out.join('\n')
}

describe('splitLines', () => {
  it('空文件是 0 行，末尾换行不产生幽灵行', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\n')).toEqual(['a'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('\n')).toEqual([''])
  })
})

describe('diffLines', () => {
  it('相同内容没有 hunk', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc')
    expect(result.hunks).toEqual([])
    expect(result.adds).toBe(0)
    expect(result.removes).toBe(0)
    expect(result.tooLarge).toBe(false)
  })

  it('单行修改：1 remove + 1 add，带上下文与双列行号', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
    const after = ['l1', 'l2', 'L3', 'l4', 'l5'].join('\n')
    const result = diffLines(before, after)
    expect(result.hunks).toHaveLength(1)
    expect(result.removes).toBe(1)
    expect(result.adds).toBe(1)
    const hunk = result.hunks[0]
    expect(hunkHeader(hunk)).toBe('@@ -1,5 +1,5 @@')
    expect(hunk.lines.map((line) => line.kind)).toEqual([
      'context',
      'context',
      'remove',
      'add',
      'context',
      'context',
    ])
    const removed = hunk.lines.find((line) => line.kind === 'remove')
    const added = hunk.lines.find((line) => line.kind === 'add')
    expect(removed).toMatchObject({ text: 'l3', oldLine: 3, newLine: null })
    expect(added).toMatchObject({ text: 'L3', oldLine: null, newLine: 3 })
    expect(applyHunks(before, result.hunks)).toBe(after)
  })

  it('开头插入 / 结尾删除', () => {
    const start = diffLines('b\nc', 'a\nb\nc')
    expect(start.adds).toBe(1)
    expect(start.removes).toBe(0)
    expect(applyHunks('b\nc', start.hunks)).toBe('a\nb\nc')

    const end = diffLines('a\nb\nc', 'a\nb')
    expect(end.adds).toBe(0)
    expect(end.removes).toBe(1)
    expect(applyHunks('a\nb\nc', end.hunks)).toBe('a\nb')
  })

  it('空文件 ↔ 非空文件', () => {
    const added = diffLines('', 'a\nb')
    expect(added.adds).toBe(2)
    expect(applyHunks('', added.hunks)).toBe('a\nb')
    const removed = diffLines('a\nb', '')
    expect(removed.removes).toBe(2)
    expect(applyHunks('a\nb', removed.hunks)).toBe('')
  })

  it('相距很远的改动拆成两个 hunk，靠近的合并成一个', () => {
    const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
    const near = oldLines.slice()
    near[1] = 'changed 2'
    near[3] = 'changed 4'
    expect(diffLines(oldLines.join('\n'), near.join('\n')).hunks).toHaveLength(1)

    const far = oldLines.slice()
    far[1] = 'changed 2'
    far[30] = 'changed 31'
    const result = diffLines(oldLines.join('\n'), far.join('\n'))
    expect(result.hunks).toHaveLength(2)
    expect(applyHunks(oldLines.join('\n'), result.hunks)).toBe(far.join('\n'))
  })

  it('改动之间超过 2*context 行 equal 才拆 hunk（上下文 3）', () => {
    const base = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)
    const gap6 = base.slice()
    gap6[2] = 'A'
    gap6[9] = 'B' // 中间 6 行 equal = 2*context → 合并
    expect(diffLines(base.join('\n'), gap6.join('\n')).hunks).toHaveLength(1)
    const gap7 = base.slice()
    gap7[2] = 'A'
    gap7[10] = 'B' // 7 行 equal → 拆开
    expect(diffLines(base.join('\n'), gap7.join('\n')).hunks).toHaveLength(2)
  })

  it('超限降级为整文件替换并置 tooLarge', () => {
    const before = Array.from({ length: 10 }, (_, index) => `old ${index}`).join('\n')
    const after = Array.from({ length: 10 }, (_, index) => `new ${index}`).join('\n')
    const result = diffLines(before, after, { maxFileLines: 5 })
    expect(result.tooLarge).toBe(true)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].lines.filter((line) => line.kind === 'remove')).toHaveLength(10)
    expect(result.hunks[0].lines.filter((line) => line.kind === 'add')).toHaveLength(10)
  })

  it('默认单文件上限是 1200 行', () => {
    expect(DIFF_MAX_FILE_LINES).toBe(1200)
    const big = Array.from({ length: 1201 }, (_, index) => `l${index}`).join('\n')
    expect(diffLines(big, big)).toMatchObject({ tooLarge: true })
  })

  it('随机改动都能被 hunk 精确重建（50 组确定性伪随机）', () => {
    let seed = 42
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let round = 0; round < 50; round += 1) {
      const length = 1 + Math.floor(rng() * 30)
      const before = Array.from({ length }, (_, index) => `b${index}`)
      const after = before.filter(() => rng() > 0.2)
      const inserts = Math.floor(rng() * 5)
      for (let index = 0; index < inserts; index += 1) {
        after.splice(Math.floor(rng() * (after.length + 1)), 0, `n${round}_${index}`)
      }
      for (let index = 0; index < after.length; index += 1) {
        if (rng() < 0.2) after[index] = `m${round}_${index}`
      }
      const beforeText = before.join('\n')
      const afterText = after.join('\n')
      const result = diffLines(beforeText, afterText)
      expect(result.tooLarge).toBe(false)
      expect(applyHunks(beforeText, result.hunks)).toBe(afterText)
    }
  })
})

describe('diffFileTrees', () => {
  it('分类 added / removed / changed', () => {
    const summary = diffFileTrees(
      [
        { path: 'a.js', content: '1' },
        { path: 'b.js', content: '2' },
      ],
      [
        { path: 'a.js', content: '1' },
        { path: 'b.js', content: '3' },
        { path: 'c.js', content: '4' },
      ],
    )
    expect(summary).toEqual({ paths: ['b.js', 'c.js'], added: ['c.js'], removed: [], changed: ['b.js'] })
  })

  it('删除文件也进 paths', () => {
    const summary = diffFileTrees([{ path: 'x', content: '1' }], [])
    expect(summary.removed).toEqual(['x'])
    expect(summary.paths).toEqual(['x'])
  })
})
