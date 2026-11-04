/**
 * creator/CreatorHost.tsx —— 创造面板的全局挂载点（轻量外壳，照 ForgeHost 的两条硬要求）。
 *
 * - `open === false` 时**零渲染**（一个 DOM 都不建）；
 * - 重量级面板（store/AI/templates/UI/CSS）由 `CreatorSurface` **懒加载**，首屏不付体积
 *   （02 §10.3 / 05 §10.3；P-40-01 首屏 gzip 增量 ≤45KB）。
 * - 本文件负责两件轻量事：`?creator=` 启动直达 + 外部 `lumen:open-creator` 请求转发。
 *
 * 宿主壳只需在 App 里挂一次 `<CreatorHost />`（shell-ui 负责）。
 */
import { Suspense, lazy, useEffect } from 'react'
import { CREATOR_OPEN_EVENT, isCreatorOpen, openCreator, useCreatorOpen } from './bridge'

const CreatorSurface = lazy(() =>
  import('./CreatorSurface').then((module) => ({ default: module.CreatorSurface })),
)

export function CreatorHost() {
  const open = useCreatorOpen()

  // `?creator=1` / `?creator=<template>` 启动直达（只影响当次会话；04 §2.1）。
  useEffect(() => {
    if (typeof location === 'undefined') return
    const params = new URLSearchParams(location.search.startsWith('?') ? location.search.slice(1) : location.search)
    if (!params.has('creator')) return
    const raw = params.get('creator')
    openCreator('url', raw && raw !== '1' ? raw : null)
  }, [])

  // 外部（测试/插件页）派发的「请求打开」事件；面板已开时忽略（防递归）。
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (isCreatorOpen()) return
      const detail = (event as CustomEvent<{ source?: string; templateId?: string }>).detail
      openCreator((detail?.source ?? 'palette') as Parameters<typeof openCreator>[0], detail?.templateId ?? null)
    }
    window.addEventListener(CREATOR_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(CREATOR_OPEN_EVENT, onOpen)
  }, [])

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <CreatorSurface />
    </Suspense>
  )
}

export default CreatorHost
