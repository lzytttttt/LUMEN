/**
 * forge/pacing.ts —— 演出节奏（对齐 `plan/v0.2.0/mock/forge.html` 的脚本时间线）。
 *
 * 生成不是"越快越好"：真实数据先到、视觉按节拍落位，用户看到的是一套演示被做出来，
 * 而不是一屏状态瞬间跳完。所有等待只作用于**表现层**（造幕台的状态机），不影响管线、
 * 不影响落库、不影响计数真值；`?still=1` 与 `?channel=replay&speed=0` 一律 0 等待（e2e/截图）。
 */
import { forcedChannelFromLocation, type AiChannelId } from '@/ai/provider'
import { replaySpeed } from '@/ai/replay'
import { isLlmReady, useSettingsStore } from '@/state/settingsStore'

export interface ForgePacing {
  /** 提交后到"大纲"出现的最短时间（mock 640ms）。 */
  seedThinkMs: number
  /** 相邻两幕落位的最短间隔（mock 560ms）。 */
  slideMs: number
  /** 最后一幕落位到过检通过/开演席的最短停留（mock 560ms）。 */
  gateHoldMs: number
  /** 重铸一次的最短可见时间（mock 760ms）。 */
  recastMs: number
  /** 开演席停留多久后自动播放（`autoPremiere` 开时；mock 是手动，这里给足看弧线的时间）。 */
  premiereHoldMs: number
}

export const NO_PACING: ForgePacing = {
  seedThinkMs: 0,
  slideMs: 0,
  gateHoldMs: 0,
  recastMs: 0,
  premiereHoldMs: 0,
}

/** 纯函数：可单测；真实取值来自 mock 样张的时间线（见文件头）。 */
export function resolvePacing(input: { still?: boolean; channel: AiChannelId; speed?: number }): ForgePacing {
  if (input.still) return NO_PACING
  // 回放 `speed=0` 是 e2e/截图的同步模式，不能加等待（否则断言要等十几秒）。
  if (input.channel === 'replay' && (input.speed ?? 1) === 0) return NO_PACING
  if (input.channel === 'mock') {
    return { seedThinkMs: 640, slideMs: 560, gateHoldMs: 560, recastMs: 760, premiereHoldMs: 2600 }
  }
  if (input.channel === 'replay') {
    // 回放有自己的录制节奏，只给一个很短的兜底，避免"零间隔"。
    return { seedThinkMs: 200, slideMs: 220, gateHoldMs: 320, recastMs: 420, premiereHoldMs: 2200 }
  }
  return { seedThinkMs: 320, slideMs: 420, gateHoldMs: 360, recastMs: 600, premiereHoldMs: 2400 }
}

/** 当前有效通道（URL 强制 > 设置里的 replay > isLlmReady）。 */
export function effectiveChannel(): AiChannelId {
  const forced = forcedChannelFromLocation()
  if (forced) return forced
  const llm = useSettingsStore.getState().llm
  if (llm.provider === 'replay') return 'replay'
  return isLlmReady(llm) ? 'openai' : 'mock'
}

export function currentPacing(still: boolean): ForgePacing {
  return resolvePacing({ still, channel: effectiveChannel(), speed: replaySpeed() })
}
