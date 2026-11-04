/**
 * creator-host.test.tsx —— 面板挂载/开关/事件钩子的 DOM 冒烟（防 2026-11-03 的栈溢出回归）。
 *
 * 关键回归：bridge.openCreator 与 Host 的 `lumen:open-creator` 监听会形成同步递归；
 * 这里在 jsdom 里真渲染 Host（含懒加载 Surface）并点开/关，断言不抛 RangeError 且 DOM 钩子正确。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreatorHost } from '@/creator/CreatorHost'
import {
  CREATOR_OPEN_EVENT,
  closeCreator,
  isCreatorOpen,
  openCreator,
  toggleCreator,
} from '@/creator/bridge'
import { useCreatorPanelStore } from '@/creator/panelState'
import { useCreatorStore } from '@/creator/store'
import { DEFAULT_PLUGINS, useSettingsStore } from '@/state/settingsStore'

let container: HTMLDivElement
let root: Root

async function waitForPanel(): Promise<Element | null> {
  await vi.waitFor(
    () => {
      expect(container.querySelector('[data-creator-panel]')).not.toBeNull()
    },
    { timeout: 3000 },
  )
  return container.querySelector('[data-creator-panel]')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useSettingsStore.setState({
    plugins: { ...DEFAULT_PLUGINS, creator: { ...DEFAULT_PLUGINS.creator, lastDraftId: null } },
  })
  useCreatorStore.getState().resetForTests()
  useCreatorPanelStore.setState({ open: false, entry: 'topbar', template: null, openHandler: null, closeHandler: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<CreatorHost />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCreatorStore.getState().resetForTests()
  useCreatorPanelStore.setState({ open: false, entry: 'topbar', template: null, openHandler: null, closeHandler: null })
  delete document.documentElement.dataset.lumenCreator
})

describe('CreatorHost', () => {
  it('关闭时零渲染，openCreator 后懒加载面板并写 html[data-lumen-creator="1"]', async () => {
    expect(container.querySelector('[data-creator-panel]')).toBeNull()
    expect(document.documentElement.dataset.lumenCreator).toBeUndefined()

    await act(async () => {
      openCreator('topbar')
      await Promise.resolve()
    })

    expect(isCreatorOpen()).toBe(true)
    const panel = await waitForPanel()
    // 懒加载 chunk 解析与 mount 副作用谁先到不确定：等 DOM 标记出现再断言（不迁就实现）。
    await vi.waitFor(() => expect(document.documentElement.dataset.lumenCreator).toBe('1'), { timeout: 3000 })
    expect(panel?.getAttribute('data-creator-state')).toBe('idle')
    expect(panel?.getAttribute('data-creator-source')).toBe('topbar')
  })

  it('顶栏 toggle / 外部事件不会递归爆栈，再 toggle 关闭后卸载 DOM', async () => {
    await act(async () => {
      toggleCreator('topbar')
      await Promise.resolve()
    })
    await waitForPanel()

    // 外部（插件页/测试）重复派发请求事件：面板已开时必须被忽略（不递归）。
    act(() => {
      window.dispatchEvent(new CustomEvent(CREATOR_OPEN_EVENT, { detail: { source: 'plugin-page' } }))
    })
    expect(isCreatorOpen()).toBe(true)

    await act(async () => {
      toggleCreator('topbar')
      await Promise.resolve()
    })
    expect(isCreatorOpen()).toBe(false)
    await vi.waitFor(() => expect(container.querySelector('[data-creator-panel]')).toBeNull())
  })

  it('状态事件派发：打开→关闭后 isCreatorOpen=false 且 store 同步', async () => {
    const events: unknown[] = []
    const listener = (event: Event) => events.push((event as CustomEvent).detail)
    window.addEventListener('lumen:creator-state', listener)

    await act(async () => {
      openCreator('palette')
      await Promise.resolve()
    })
    await waitForPanel()
    await act(async () => {
      closeCreator()
      await Promise.resolve()
    })
    window.removeEventListener('lumen:creator-state', listener)

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(isCreatorOpen()).toBe(false)
    expect(useCreatorStore.getState().panelOpen).toBe(false)
  })
})
