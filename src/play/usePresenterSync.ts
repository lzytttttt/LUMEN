/**
 * usePresenterSync.ts —— 主窗侧：广播播放状态、接收讲者窗命令、管理窗口生命周期。
 *
 * 只用 BroadcastChannel，不做轮询式握手：
 * - 讲者窗加载完发 `hello`，主窗回 `deck` + `state`（避免"打开瞬间状态已发完"的竞态）；
 * - 主窗在幕号/黑屏/自动播放/整秒计时变化时推 `state`（计时按秒节流，不刷屏）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Deck } from '@/schema/deck'
import type { Lang } from '@/i18n'
import {
  canBroadcast,
  isSyncMessage,
  SYNC_CHANNEL,
  type PresenterAction,
  type SyncDeckMessage,
  type SyncStateMessage,
} from './presenter'
import { openPresenterWindow } from './PresenterWindow'

export interface PresenterSyncOptions {
  deck: Deck
  lang: Lang
  index: number
  total: number
  blackout: boolean
  autoplay: boolean
  elapsedMs: number
  onAction: (action: PresenterAction, index?: number) => void
}

export interface PresenterSyncApi {
  /** 打开讲者窗；返回 false 表示被浏览器拦截或环境不支持（调用方 toast）。 */
  open: () => boolean
  close: () => void
  isOpen: boolean
}

export function usePresenterSync(opts: PresenterSyncOptions): PresenterSyncApi {
  const { deck, lang, index, total, blackout, autoplay, elapsedMs, onAction } = opts
  const [isOpen, setOpen] = useState(false)

  const channelRef = useRef<BroadcastChannel | null>(null)
  const winRef = useRef<Window | null>(null)
  const actionRef = useRef(onAction)
  const langRef = useRef(lang)
  actionRef.current = onAction
  langRef.current = lang

  const stateMsgRef = useRef<SyncStateMessage | null>(null)
  const deckMsgRef = useRef<SyncDeckMessage | null>(null)

  const post = useCallback((message: unknown) => {
    try {
      channelRef.current?.postMessage(message)
    } catch {
      /* 关窗竞态，忽略 */
    }
  }, [])

  const postState = useCallback(() => {
    if (stateMsgRef.current) post(stateMsgRef.current)
  }, [post])

  const postDeck = useCallback(() => {
    if (deckMsgRef.current) post(deckMsgRef.current)
  }, [post])

  // 频道创建 + 命令接收（只建一次，避免重连丢消息）。
  useEffect(() => {
    if (!canBroadcast()) return
    const channel = new BroadcastChannel(SYNC_CHANNEL)
    channelRef.current = channel
    channel.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data
      if (!isSyncMessage(message)) return
      if (message.type === 'command') {
        actionRef.current(message.action, message.index)
      } else if (message.type === 'hello') {
        // 讲者窗刚连上：把全量信息补一遍。
        postDeck()
        postState()
      }
    }
    return () => {
      channel.onmessage = null
      try {
        channel.close()
      } catch {
        /* noop */
      }
      channelRef.current = null
    }
  }, [postDeck, postState])

  // deck（标题 + 备注）只在需要时推：这里跟着 deck 引用变化更新缓存。
  useEffect(() => {
    deckMsgRef.current = {
      type: 'deck',
      title: deck.title,
      slides: deck.slides.map((slide) => ({
        name: slide.name ?? '',
        notes: slide.notes ?? '',
      })),
    }
    if (winRef.current && !winRef.current.closed) postDeck()
  }, [deck, postDeck])

  // 状态按秒节流后广播。
  const elapsedSecond = Math.floor(elapsedMs / 1000)
  useEffect(() => {
    stateMsgRef.current = {
      type: 'state',
      index,
      blackout,
      autoplay,
      elapsedMs: elapsedSecond * 1000,
      total,
    }
    if (winRef.current && !winRef.current.closed) postState()
  }, [index, blackout, autoplay, elapsedSecond, total, postState])

  // 窗口关闭检测：讲者窗自己关掉不影响主窗，只是把按钮状态收回来。
  useEffect(() => {
    if (!isOpen) return
    const id = window.setInterval(() => {
      if (winRef.current?.closed) {
        winRef.current = null
        setOpen(false)
      }
    }, 800)
    return () => window.clearInterval(id)
  }, [isOpen])

  const close = useCallback(() => {
    const win = winRef.current
    winRef.current = null
    setOpen(false)
    if (win && !win.closed) {
      try {
        win.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  const open = useCallback(() => {
    if (!canBroadcast()) return false
    const existing = winRef.current
    if (existing && !existing.closed) {
      try {
        existing.focus()
      } catch {
        /* noop */
      }
      return true
    }
    const win = openPresenterWindow(langRef.current)
    if (!win) return false
    winRef.current = win
    setOpen(true)
    // 讲者窗脚本会发 hello；这里立刻补一次，避免脚本还没挂上监听时错过首帧。
    postDeck()
    postState()
    return true
  }, [postDeck, postState])

  // 主窗卸载 / 关闭 → 讲者窗一起关（反过来不成立）。
  useEffect(() => {
    const onBeforeUnload = () => close()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      close()
    }
  }, [close])

  return { open, close, isOpen }
}
