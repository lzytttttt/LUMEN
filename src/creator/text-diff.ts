/**
 * creator/text-diff.ts —— 自写行级 diff（04 §5.3 / D-40-07，零依赖）。
 *
 * 口径（06 §4.1 U-40-185/186、04 §5.3）：
 * - Myers 算法求最短编辑脚本，上下文 3 行、unified hunk、双列行号；
 * - 硬上限：单文件 ≤1200 行、两版合计 ≤2400 行；超限降级「整文件替换」并置 `tooLarge`，
 *   由 UI 提示 `creator.view.tooLarge`（不静默截断、不假装没差异）；
 * - 只返回数据，不拼 HTML/ANSI：渲染归 DiffView。
 */

/** 单文件行数上限（超过即降级）。 */
export const DIFF_MAX_FILE_LINES = 1200
/** 两版合计行数上限。 */
export const DIFF_MAX_TOTAL_LINES = 2400
/** unified diff 上下文行数。 */
export const DIFF_CONTEXT = 3

export type DiffLineKind = 'context' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based 旧文件行号；add 行为 null。 */
  oldLine: number | null
  /** 1-based 新文件行号；remove 行为 null。 */
  newLine: number | null
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffResult {
  hunks: DiffHunk[]
  adds: number
  removes: number
  /** 命中体积上限：`hunks` 是整文件替换的退化结果。 */
  tooLarge: boolean
  /** 输入行数（诊断用）。 */
  oldCount: number
  newCount: number
}

type EditKind = 'equal' | 'add' | 'remove'

interface EditOp {
  kind: EditKind
  text: string
  oldIndex: number
  newIndex: number
}

/** 按 `\n` 切行；保留空文件语义（'' → []，'a\n' → ['a']）。 */
export function splitLines(text: string): string[] {
  if (typeof text !== 'string') return []
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  // 末尾换行不产生「空行」——行数按内容行算，否则 diff 尾巴会多出幽灵行。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Myers 最短编辑脚本（只在公共前后缀之间跑，降低最坏复杂度）。
 * 返回按原顺序排列的 equal/remove/add 序列。
 */
function myers(before: string[], after: string[]): EditOp[] {
  const n = before.length
  const m = after.length

  // 先剥公共前后缀：对称差异场景下能把 D 降到很小。
  let prefix = 0
  while (prefix < n && prefix < m && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < n - prefix && suffix < m - prefix && before[n - 1 - suffix] === after[m - 1 - suffix]) {
    suffix += 1
  }

  const midN = n - prefix - suffix
  const midM = m - prefix - suffix
  const a = before.slice(prefix, n - suffix)
  const b = after.slice(prefix, m - suffix)

  const ops: EditOp[] = []
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: 'equal', text: before[index], oldIndex: index, newIndex: index })
  }

  if (midN === 0) {
    for (let index = 0; index < midM; index += 1) {
      ops.push({ kind: 'add', text: b[index], oldIndex: prefix, newIndex: prefix + index })
    }
  } else if (midM === 0) {
    for (let index = 0; index < midN; index += 1) {
      ops.push({ kind: 'remove', text: a[index], oldIndex: prefix + index, newIndex: prefix })
    }
  } else {
    const max = midN + midM
    const offset = max
    const v = new Int32Array(2 * max + 1)
    /** trace[d] = 第 d 步开始前的 V 快照（回溯依据）。 */
    const trace: Int32Array[] = []
    let endD = 0

    outer: for (let d = 0; d <= max; d += 1) {
      trace.push(v.slice())
      for (let k = -d; k <= d; k += 2) {
        const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1
        let y = x - k
        while (x < midN && y < midM && a[x] === b[y]) {
          x += 1
          y += 1
        }
        v[offset + k] = x
        if (x >= midN && y >= midM) {
          endD = d
          break outer
        }
      }
    }

    // 回溯：从 (midN, midM) 走回 (0,0)，收集编辑动作（含 equal），最后反转。
    const reversed: EditOp[] = []
    let x = midN
    let y = midM
    for (let d = endD; d > 0; d -= 1) {
      const previous = trace[d]
      const k = x - y
      const down = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])
      const previousK = down ? k + 1 : k - 1
      const previousX = previous[offset + previousK]
      const previousY = previousX - previousK
      while (x > previousX && y > previousY) {
        x -= 1
        y -= 1
        reversed.push({
          kind: 'equal',
          text: a[x],
          oldIndex: prefix + x,
          newIndex: prefix + y,
        })
      }
      if (down) {
        y -= 1
        reversed.push({ kind: 'add', text: b[y], oldIndex: prefix + x, newIndex: prefix + y })
      } else {
        x -= 1
        reversed.push({ kind: 'remove', text: a[x], oldIndex: prefix + x, newIndex: prefix + y })
      }
    }
    // (0,0) 之前若还有纯 equal 前缀已被 prefix 处理；这里只补残余对角线（防御，正常为 0 步）。
    while (x > 0 && y > 0) {
      x -= 1
      y -= 1
      reversed.push({ kind: 'equal', text: a[x], oldIndex: prefix + x, newIndex: prefix + y })
    }
    for (let index = reversed.length - 1; index >= 0; index -= 1) ops.push(reversed[index])
  }

  for (let index = 0; index < suffix; index += 1) {
    ops.push({
      kind: 'equal',
      text: before[n - suffix + index],
      oldIndex: n - suffix + index,
      newIndex: m - suffix + index,
    })
  }
  return ops
}

/** 整文件替换的退化结果（超限时用）。 */
function wholeFileReplacement(before: string[], after: string[]): DiffHunk {
  const lines: DiffLine[] = []
  for (let index = 0; index < before.length; index += 1) {
    lines.push({ kind: 'remove', text: before[index], oldLine: index + 1, newLine: null })
  }
  for (let index = 0; index < after.length; index += 1) {
    lines.push({ kind: 'add', text: after[index], oldLine: null, newLine: index + 1 })
  }
  return {
    oldStart: before.length > 0 ? 1 : 0,
    oldLines: before.length,
    newStart: after.length > 0 ? 1 : 0,
    newLines: after.length,
    lines,
  }
}

export interface DiffOptions {
  /** 上下文行数，默认 3。 */
  context?: number
  /** 单文件行数上限（默认 1200）。 */
  maxFileLines?: number
  /** 两版合计行数上限（默认 2400）。 */
  maxTotalLines?: number
}

/**
 * 行级 unified diff。
 * 相同内容返回 `hunks: []`；超限返回整文件替换 + `tooLarge: true`。
 */
export function diffLines(beforeText: string, afterText: string, options: DiffOptions = {}): DiffResult {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  const context = Math.max(0, options.context ?? DIFF_CONTEXT)
  const maxFileLines = options.maxFileLines ?? DIFF_MAX_FILE_LINES
  const maxTotalLines = options.maxTotalLines ?? DIFF_MAX_TOTAL_LINES
  const tooLarge =
    before.length > maxFileLines || after.length > maxFileLines || before.length + after.length > maxTotalLines

  if (tooLarge) {
    const hunks = before.length + after.length > 0 ? [wholeFileReplacement(before, after)] : []
    return {
      hunks,
      adds: after.length,
      removes: before.length,
      tooLarge: true,
      oldCount: before.length,
      newCount: after.length,
    }
  }

  const ops = myers(before, after)
  const adds = ops.filter((op) => op.kind === 'add').length
  const removes = ops.filter((op) => op.kind === 'remove').length
  if (adds === 0 && removes === 0) {
    return { hunks: [], adds: 0, removes: 0, tooLarge: false, oldCount: before.length, newCount: after.length }
  }

  /** 把编辑序列切成带上下文的 hunk（相隔 ≤2*context 的改动合并）。 */
  const hunks: DiffHunk[] = []
  let cursor = 0
  while (cursor < ops.length) {
    // 找到下一处改动。
    while (cursor < ops.length && ops[cursor].kind === 'equal') cursor += 1
    if (cursor >= ops.length) break
    const changeStart = cursor
    let changeEnd = cursor
    // 向后吞改动，直到「连续 2*context+1 行 equal」后停止。
    while (changeEnd < ops.length) {
      if (ops[changeEnd].kind !== 'equal') {
        changeEnd += 1
        continue
      }
      let run = 0
      while (changeEnd + run < ops.length && ops[changeEnd + run].kind === 'equal') run += 1
      if (run > context * 2) break
      changeEnd += run
    }
    const from = Math.max(0, changeStart - context)
    const to = Math.min(ops.length, changeEnd + context)
    const slice = ops.slice(from, to)
    const lines: DiffLine[] = slice.map((op) => ({
      kind: op.kind === 'equal' ? 'context' : op.kind,
      text: op.text,
      oldLine: op.kind === 'add' ? null : op.oldIndex + 1,
      newLine: op.kind === 'remove' ? null : op.newIndex + 1,
    }))
    const oldLines = slice.filter((op) => op.kind !== 'add').length
    const newLines = slice.filter((op) => op.kind !== 'remove').length
    const oldStart = oldLines > 0 ? (slice.find((op) => op.kind !== 'add')?.oldIndex ?? 0) + 1 : 0
    const newStart = newLines > 0 ? (slice.find((op) => op.kind !== 'remove')?.newIndex ?? 0) + 1 : 0
    hunks.push({ oldStart, oldLines, newStart, newLines, lines })
    cursor = to
  }

  return { hunks, adds, removes, tooLarge: false, oldCount: before.length, newCount: after.length }
}

/** hunk 头的 unified 文本（`@@ -a,b +c,d @@`），UI 可直显。 */
export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/**
 * 两版文件树之间的差异摘要（文件树列表用）。
 * `paths` 为「有改动的文件」，`added/removed` 便于徽标显示。
 */
export interface FileDiffSummary {
  paths: string[]
  added: string[]
  removed: string[]
  changed: string[]
}

export function diffFileTrees(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[],
): FileDiffSummary {
  const oldMap = new Map(before.map((file) => [file.path, file.content]))
  const newMap = new Map(after.map((file) => [file.path, file.content]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [path, content] of newMap) {
    if (!oldMap.has(path)) added.push(path)
    else if (oldMap.get(path) !== content) changed.push(path)
  }
  for (const path of oldMap.keys()) if (!newMap.has(path)) removed.push(path)
  const paths = [...new Set([...added, ...removed, ...changed])].sort()
  return { paths, added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

/** 从提案文件里找代码/清单文件（代码视图默认选中项）。 */
export function defaultCodePath(files: { path: string }[]): string {
  const code = files.find((file) => file.path === 'plugin.js')
  if (code) return code.path
  const manifest = files.find((file) => file.path === '.lumen-plugin.json')
  return manifest?.path ?? files[0]?.path ?? ''
}
