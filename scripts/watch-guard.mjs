#!/usr/bin/env node
/**
 * 预加载守卫：让 vite 的文件监听在 Windows 上不再被瞬时文件锁打死。
 *
 * 背景：chokidar 的 NodeFsHandler 会对每个被监听的文件调用 fs.watch，
 * 一旦其它进程（编辑器原子写、杀软/同步盘扫描）短暂占用该文件，
 * Windows 会在 watcher 上抛 EBUSY/EPERM 的 'error' 事件；
 * vite 未挂 error 监听 → uncaughtException → 整个 dev server 直接退出。
 * 典型现场：LICENSE-CC-BY-NC-4.0.txt、public/portal/avatar.png。
 *
 * 用法：node --import=./scripts/watch-guard.mjs ./node_modules/vite/bin/vite.js ...
 */
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

/** 视为“文件被临时占用”的错误码：只降级，不吞真正的编程错误。 */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOSPC'])

const warned = new Set()

const isBusy = (error) => Boolean(error) && BUSY_CODES.has(error.code) && String(error.syscall ?? '').startsWith('watch')

const label = (target) => (typeof target === 'string' ? target : String(target?.toString?.() ?? target))

function warnOnce(target, error) {
  const key = `${error.code}:${label(target)}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[watch-guard] 跳过被占用的监听目标 ${label(target)}（${error.code}），HMR 对该文件失效`)
}

/** 与 fs.FSWatcher 接口兼容的空 watcher：可 close/ref/unref，永不发事件。 */
function inertWatcher() {
  const watcher = new EventEmitter()
  watcher.close = () => watcher.emit('close')
  watcher.ref = () => watcher
  watcher.unref = () => watcher
  return watcher
}

const originalWatch = fs.watch

fs.watch = function watch(target, options, listener) {
  if (typeof options === 'function') {
    listener = options
    options = undefined
  }

  let watcher
  try {
    watcher = originalWatch.call(fs, target, options, listener)
  } catch (error) {
    if (isBusy(error)) {
      warnOnce(target, error)
      return inertWatcher()
    }
    throw error
  }

  // 异步错误（Windows 上更常见）：在 chokidar 的 error 监听被调用之前就把占用的错误丢掉，
  // 否则它会冒泡到 FSWatcher 上，成为无人处理的 'error' 事件。
  if (watcher && typeof watcher.emit === 'function') {
    const originalEmit = watcher.emit
    watcher.emit = function emit(event, ...args) {
      if (event === 'error' && isBusy(args[0])) {
        warnOnce(target, args[0])
        return false
      }
      return originalEmit.call(this, event, ...args)
    }
  }

  return watcher
}

// 兜底：即使某条路径绕过了上面的包装，也不要因为一次瞬时锁而丢掉整个 dev server。
process.on('uncaughtException', (error) => {
  if (isBusy(error)) {
    warnOnce(error.path ?? '<unknown>', error)
    return
  }
  console.error(error)
  process.exit(1)
})
