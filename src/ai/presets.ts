/**
 * presets.ts —— 通道预设档（`05` §3）：纯数据 + 一个纯函数，无副作用、无 UI。
 *
 * 选档只写 `LlmSettings` 的 7 个字段（`provider/baseURL/model/format/firstByteTimeoutMs/
 * concurrency/presetId`），**不碰** `apiKey`、`temperature`、`stream`、`cache`、`maxRetries`。
 * 用户手改任一字段后由设置页把 `presetId` 置 null（显示为「自定义」），这里不回写。
 *
 * `self` 档的端点是会话模型的 OpenAI 兼容网关：运行期从构建 env 取，缺省保留占位符，
 * 绝不把真实地址写死进仓库（发行包该 env 为空 → 走 `notConfigured`）。
 */
import type { LlmFormat, LlmSettings } from '@/state/settingsStore'
import type { AiChannelId, AiFormat } from './provider'

export type PresetId = 'mock' | 'deepseek' | 'openai' | 'ollama' | 'gateway' | 'self'

export interface ChannelPreset {
  id: PresetId
  /** i18n key（`ai.panel.preset.*`），不写字面量。 */
  labelKey: string
  provider: AiChannelId
  /** `self` / `gateway` 用占位符，运行期由 `applyPreset` 解析。 */
  baseURL: string
  model: string
  needsKey: boolean
  format: AiFormat
  firstByteTimeoutMs: number
  concurrency: 1 | 2 | 3
}

/** 六档预设（§3 表格逐行落成数据）。 */
export const PRESETS: readonly ChannelPreset[] = [
  {
    id: 'mock',
    labelKey: 'ai.panel.preset.mock',
    provider: 'mock',
    baseURL: '',
    model: '',
    needsKey: false,
    format: 'none',
    firstByteTimeoutMs: 12_000,
    concurrency: 2,
  },
  {
    id: 'deepseek',
    labelKey: 'ai.panel.preset.deepseek',
    provider: 'openai',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    needsKey: true,
    format: 'auto',
    firstByteTimeoutMs: 12_000,
    concurrency: 2,
  },
  {
    id: 'openai',
    labelKey: 'ai.panel.preset.openai',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    format: 'json_schema',
    firstByteTimeoutMs: 12_000,
    concurrency: 2,
  },
  {
    id: 'ollama',
    labelKey: 'ai.panel.preset.ollama',
    provider: 'openai',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    format: 'none',
    // 冷启动 3–10s（待测），首字节单独抬到 30s。
    firstByteTimeoutMs: 30_000,
    concurrency: 1,
  },
  {
    id: 'gateway',
    labelKey: 'ai.panel.preset.gateway',
    provider: 'openai',
    baseURL: 'https://GW_HOST/v1',
    model: 'GW_MODEL',
    needsKey: true,
    format: 'auto',
    firstByteTimeoutMs: 12_000,
    concurrency: 2,
  },
  {
    id: 'self',
    labelKey: 'ai.panel.preset.self',
    provider: 'openai',
    baseURL: 'SELF_BASE_URL',
    model: 'SELF_MODEL',
    needsKey: true,
    format: 'auto',
    firstByteTimeoutMs: 12_000,
    concurrency: 2,
  },
] as const

/** `AiFormat` → 设置里的四态（`json_object` 显示为「JSON」，`json_schema` 显示为「严格」）。 */
export const FORMAT_TO_LLM: Record<AiFormat, LlmFormat> = {
  auto: 'auto',
  json_object: 'json',
  json_schema: 'strict',
  none: 'none',
}

export function llmFormatOf(format: AiFormat): LlmFormat {
  return FORMAT_TO_LLM[format]
}

export function presetOf(id: PresetId | string | null | undefined): ChannelPreset | undefined {
  if (id === null || id === undefined) return undefined
  return PRESETS.find((preset) => preset.id === id)
}

function envOf(key: 'VITE_LLM_SELF_BASE' | 'VITE_LLM_SELF_MODEL'): string {
  try {
    const env = (import.meta as { env?: Record<string, unknown> }).env
    const value = env?.[key]
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/** `self` 档的真实端点：env 有值用 env，否则保留占位符（不会指向任何真实主机）。 */
export function resolveSelfEndpoint(preset: ChannelPreset): { baseURL: string; model: string } {
  if (preset.id !== 'self') return { baseURL: preset.baseURL, model: preset.model }
  return {
    baseURL: envOf('VITE_LLM_SELF_BASE') || preset.baseURL,
    model: envOf('VITE_LLM_SELF_MODEL') || preset.model,
  }
}

/**
 * 纯函数：把某一档写进设置（只写 7 个字段 + 保留原有 apiKey/temperature）。
 * 未知 id 原样返回，便于设置页「自定义」态兜底。
 */
export function applyPreset(llm: LlmSettings, id: PresetId | string): LlmSettings {
  const preset = presetOf(id)
  if (!preset) return llm
  const endpoint = resolveSelfEndpoint(preset)
  return {
    ...llm,
    provider: preset.provider,
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    format: llmFormatOf(preset.format),
    firstByteTimeoutMs: preset.firstByteTimeoutMs,
    concurrency: preset.concurrency,
    presetId: preset.id,
  }
}
