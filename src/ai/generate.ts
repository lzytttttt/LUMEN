/**
 * generate.ts —— 单点生成：SVG 插图与 3D 场景描述符。
 *
 * 两条通道同一入口：真端点按 prompts.ts 的契约返回 JSON，Mock 走确定性生成器。
 * 生成结果一律再过 `sanitizeSvgDocument` / `threeDescriptorSchema`，
 * 真端点产物不合格时自动退回本地素材（并标记 provider 为 `x:fallback`）。
 */
import { z } from 'zod'
import type { ThreeDescriptor } from '@/schema/deck'
import { threeDescriptorSchema } from '@/schema/deck'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import { useSettingsStore } from '@/state/settingsStore'
import { mockSvgArt, mockThreeScene } from './art'
import { currentProvider, isAborted } from './provider'
import { svgRequest, threeRequest } from './prompts'
import { parseWithRepair, repairPrompt } from './validate'
import type { GenerateSvgResult, GenerateThreeResult } from './types'

const svgPayloadSchema = z.object({
  svg: z.string().min(1),
  viewBox: z.array(z.number()).length(4).optional(),
  caption: z.string().max(200).optional(),
})

const threePayloadSchema = z.object({ descriptor: threeDescriptorSchema })

function modelOf(providerId: string): string | undefined {
  return providerId === 'openai' ? useSettingsStore.getState().llm.model : undefined
}

function fallbackSvg(prompt: string, style: string | undefined, providerId: string): GenerateSvgResult {
  const art = mockSvgArt(prompt, { style })
  const clean = sanitizeSvgDocument(art.source)
  return { source: clean.svg, provider: `${providerId}:fallback` }
}

/** 一句话 → 一张可直接嵌入的 SVG（已净化、已令牌化）。 */
export async function generateSvgArt(
  prompt: string,
  opts?: { style?: string; signal?: AbortSignal },
): Promise<GenerateSvgResult> {
  const provider = currentProvider()
  const model = modelOf(provider.id)
  const req = svgRequest(prompt, opts?.style)
  try {
    const res = await provider.complete({
      system: req.system,
      user: req.user,
      json: true,
      temperature: 0.7,
      signal: opts?.signal,
    })
    const parsed = await parseWithRepair(svgPayloadSchema, res.text, {
      signal: opts?.signal,
      repair:
        provider.id === 'openai'
          ? async (issues) => {
              const retry = await provider.complete({
                system: req.system,
                user: repairPrompt(req.user, issues),
                json: true,
                signal: opts?.signal,
              })
              return retry.text
            }
          : undefined,
    })
    const clean = sanitizeSvgDocument(parsed.svg)
    if (clean.svg.trim() === '') return fallbackSvg(prompt, opts?.style, provider.id)
    return { source: clean.svg, provider: provider.id, model }
  } catch (error) {
    if (isAborted(error)) throw error
    return fallbackSvg(prompt, opts?.style, provider.id)
  }
}

/** 一句话 → 一个受限 3D 描述符（已通过 threeDescriptorSchema）。 */
export async function generateThreeScene(
  prompt: string,
  opts?: { signal?: AbortSignal },
): Promise<GenerateThreeResult> {
  const provider = currentProvider()
  const model = modelOf(provider.id)
  const req = threeRequest(prompt)
  try {
    const res = await provider.complete({
      system: req.system,
      user: req.user,
      json: true,
      temperature: 0.6,
      signal: opts?.signal,
    })
    const parsed = await parseWithRepair(threePayloadSchema, res.text, {
      signal: opts?.signal,
      repair:
        provider.id === 'openai'
          ? async (issues) => {
              const retry = await provider.complete({
                system: req.system,
                user: repairPrompt(req.user, issues),
                json: true,
                signal: opts?.signal,
              })
              return retry.text
            }
          : undefined,
    })
    return { descriptor: parsed.descriptor as ThreeDescriptor, provider: provider.id, model }
  } catch (error) {
    if (isAborted(error)) throw error
    return { descriptor: mockThreeScene(prompt), provider: `${provider.id}:fallback`, model }
  }
}
