/**
 * fileSync.ts —— 可选的"本地文件自动落盘"（File System Access API）。
 *
 * 为什么需要：IndexedDB 会被"清理站点数据 / 存储配额回收"一键抹掉，而用户往往没有
 * 手动导出 `.lumen.json`。在支持 `showSaveFilePicker` 的 Chromium 里，可以把当前工程
 * 关联到一个本地文件，自动保存时顺带镜像过去；其它浏览器保持原行为。
 *
 * 设计取舍：
 * - **句柄持久化**：FileSystemFileHandle 可结构化克隆，存进 IndexedDB 的 settings 表，
 *   下次启动（同一浏览器 + 同一站点）可恢复关联，不要求用户每次重新授权；
 * - **用户手势才请求权限**：`requestPermission` 必须在点击里调用；自动保存只查询权限，
 *   被拒就把状态降级为 denied，绝不弹窗骚扰；
 * - **节流写入**：自动保存 800ms 一次，但磁盘写入至少间隔 4s；最后一次改动仍会补写；
 * - **完整工程**：写入的是和"导出工程文件"同构的 JSON（含素材 dataURL），可直接导入；
 * - **任何失败都不影响 IndexedDB 自动保存**，只更新状态/提示。
 */
import type { Deck } from '@/schema/deck'
import { buildProjectFile } from '@/export/projectFile'
import { kvDel, kvGet, kvSet } from './kv'

const HANDLE_KEY = 'file-sync-handle'

export type FileSyncStatus = 'unsupported' | 'unlinked' | 'linked' | 'denied' | 'error'

export interface FileSyncState {
  supported: boolean
  status: FileSyncStatus
  fileName?: string
  error?: string
}

/** File System Access 的最小结构类型（lib.dom 未内置 showSaveFilePicker）。 */
interface WritableLike {
  write: (data: Blob | string) => Promise<void>
  close: () => Promise<void>
}

interface FileHandleLike {
  name: string
  createWritable: () => Promise<WritableLike>
  queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>
}

interface PickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<FileHandleLike>
}

const MIN_WRITE_INTERVAL_MS = 4000
const TRAILING_DELAY_MS = 1400

let handle: FileHandleLike | null = null
let state: FileSyncState = {
  supported: typeof window !== 'undefined' && typeof (window as PickerWindow).showSaveFilePicker === 'function',
  status: 'unlinked',
}
let listeners = new Set<(state: FileSyncState) => void>()
let lastWriteAt = 0
let pendingDeck: Deck | null = null
let writeTimer: number | undefined
let writeChain: Promise<void> = Promise.resolve()

function emit(next: FileSyncState): void {
  state = next
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch (error) {
      console.warn('[file-sync] listener failed', error)
    }
  }
}

export function isFileSyncSupported(): boolean {
  return state.supported
}

export function getFileSyncState(): FileSyncState {
  return state
}

export function subscribeFileSync(listener: (state: FileSyncState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function picker(): PickerWindow['showSaveFilePicker'] | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as PickerWindow).showSaveFilePicker
}

function isValidHandle(value: unknown): value is FileHandleLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as FileHandleLike).name === 'string' &&
      typeof (value as FileHandleLike).createWritable === 'function',
  )
}

/** 启动时恢复上次关联（不请求权限，只查询）。 */
export async function restoreFileLink(): Promise<FileSyncState> {
  if (!state.supported) {
    emit({ supported: false, status: 'unsupported' })
    return state
  }
  if (handle) return state
  try {
    const stored = await kvGet<unknown>('settings', HANDLE_KEY)
    if (isValidHandle(stored)) {
      handle = stored
      // 恢复后先探一次权限：prompt 也先标 linked，等真正写入时再判断。
      emit({ supported: true, status: 'linked', fileName: stored.name })
    } else {
      emit({ supported: true, status: 'unlinked' })
    }
  } catch (error) {
    console.warn('[file-sync] 恢复本地文件关联失败', error)
    emit({ supported: true, status: 'unlinked' })
  }
  return state
}

async function hasWritePermission(request: boolean): Promise<boolean> {
  if (!handle) return false
  if (typeof handle.queryPermission !== 'function') return true
  try {
    const current = await handle.queryPermission({ mode: 'readwrite' })
    if (current === 'granted') return true
    if (current === 'prompt' && request && typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
    }
    return false
  } catch {
    return false
  }
}

async function writeProject(deck: Deck): Promise<boolean> {
  if (!handle) return false
  if (!(await hasWritePermission(false))) {
    emit({
      supported: true,
      status: 'denied',
      fileName: handle.name,
      error: 'permission',
    })
    return false
  }
  const project = await buildProjectFile(deck)
  const writable = await handle.createWritable()
  try {
    await writable.write(JSON.stringify(project, null, 2))
  } finally {
    await writable.close()
  }
  lastWriteAt = Date.now()
  emit({ supported: true, status: 'linked', fileName: handle.name })
  return true
}

function scheduleWrite(deck: Deck): void {
  pendingDeck = deck
  if (writeTimer !== undefined) return
  const wait = Math.max(0, MIN_WRITE_INTERVAL_MS - (Date.now() - lastWriteAt))
  writeTimer = window.setTimeout(() => {
    writeTimer = undefined
    const next = pendingDeck
    pendingDeck = null
    if (!next || !handle) return
    writeChain = writeChain
      .then(async () => {
        const ok = await writeProject(next)
        if (!ok) return
        // 写入期间又有新改动：等节流窗口结束后补写最后一版。
        if (pendingDeck && writeTimer === undefined) {
          writeTimer = window.setTimeout(() => {
            writeTimer = undefined
            const latest = pendingDeck
            pendingDeck = null
            if (latest && handle) writeChain = writeChain.then(() => writeProject(latest).then(() => undefined))
          }, TRAILING_DELAY_MS)
        }
      })
      .catch((error) => {
        console.warn('[file-sync] 写入失败', error)
        emit({
          supported: true,
          status: 'error',
          fileName: handle?.name,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, wait)
}

/** 自动保存调用：没有关联时是零开销 no-op。 */
export function queueDeckFileWrite(deck: Deck): void {
  if (!handle || !state.supported) return
  if (state.status === 'denied') return
  try {
    scheduleWrite(deck)
  } catch (error) {
    console.warn('[file-sync] 排队写入失败', error)
  }
}

/** 页面隐藏/关闭前尽量把最后一版写完（不保证浏览器等待）。 */
export async function flushDeckFileWrite(): Promise<void> {
  if (!handle) return
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer)
    writeTimer = undefined
  }
  const next = pendingDeck
  pendingDeck = null
  if (next) writeChain = writeChain.then(() => writeProject(next).then(() => undefined))
  await writeChain.catch(() => undefined)
}

/** 关联本地文件（必须在点击事件里调用，浏览器才允许弹保存框）。 */
export async function linkDeckFile(deck: Deck | null): Promise<FileSyncState> {
  const show = picker()
  if (!show) {
    emit({ supported: false, status: 'unsupported' })
    return state
  }
  try {
    const next = await show({
      suggestedName: `${(deck?.title ?? 'lumen-deck').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'lumen-deck'}.lumen.json`,
      types: [{ description: 'LUMEN deck', accept: { 'application/json': ['.json'] } }],
    })
    handle = next
    await kvSet('settings', HANDLE_KEY, next)
    emit({ supported: true, status: 'linked', fileName: next.name })
    const permitted = await hasWritePermission(true)
    if (!permitted) {
      emit({ supported: true, status: 'denied', fileName: next.name, error: 'permission' })
      return state
    }
    if (deck) await writeProject(deck)
    return state
  } catch (error) {
    // 用户取消保存框：保持原状态，不当作错误。
    if (error instanceof DOMException && error.name === 'AbortError') return state
    emit({
      supported: true,
      status: 'error',
      fileName: handle?.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return state
  }
}

/** 解除关联（只清本地句柄，不删用户磁盘上的文件）。 */
export async function unlinkDeckFile(): Promise<FileSyncState> {
  handle = null
  pendingDeck = null
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer)
    writeTimer = undefined
  }
  await kernelDelete()
  emit({ supported: state.supported, status: 'unlinked' })
  return state
}

async function kernelDelete(): Promise<void> {
  try {
    await kvDel('settings', HANDLE_KEY)
  } catch (error) {
    console.warn('[file-sync] 清除本地文件关联失败', error)
  }
}
