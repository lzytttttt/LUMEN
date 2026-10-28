/**
 * ai/port.ts —— 「一句话生成」到 AI 层的可选端口。
 *
 * 背景：`src/ai/**` 由 ai-composer 并行开发。工作室不能因为对方文件还没落地就编译失败，
 * 所以这里用 `import.meta.glob` 做**构建期可选探测**：
 * - `src/ai/index.ts` 一旦存在并且导出 `generateSvgArt` / `generateThreeScene`，自动接上；
 * - 不存在时 `getStudioAiPort()` 返回 null，UI 显示「生成入口未就绪」而不是报错；
 * - 另外提供 `registerStudioAiPort(port)`，允许显式注入（测试夹具、未来的别的 provider）。
 */
import type { ThreeDescriptor } from '@/schema/deck'

export interface SvgArtResult {
  source: string
  provider: string
  model?: string
}

export interface ThreeSceneResult {
  descriptor: ThreeDescriptor
  provider: string
  model?: string
}

export interface StudioAiPort {
  generateSvgArt(
    prompt: string,
    opts?: { style?: string; palette?: string[]; signal?: AbortSignal },
  ): Promise<SvgArtResult>
  generateThreeScene(prompt: string, opts?: { signal?: AbortSignal }): Promise<ThreeSceneResult>
}

/* ------------------------------- 显式注册 ------------------------------- */

let injected: StudioAiPort | null = null

/** 注入（传 null 取消）。同名的裸函数导出留给 Lead / ai-composer 复用。 */
export function registerStudioAiPort(port: StudioAiPort | null): void {
  injected = port
}

export function getRegisteredStudioAiPort(): StudioAiPort | null {
  return injected
}

/* ------------------------------- 可选探测 ------------------------------- */

// 只探测唯一入口 `src/ai/index.ts`（ai 的公共 API 出口）。
// 文件不存在时 glob 返回空对象 → `getStudioAiPort()` 解析为 null → 工作室显示「生成入口未就绪」。
const AI_MODULES = import.meta.glob('/src/ai/index.ts')

type ModuleLoader = () => Promise<unknown>

function entryLoader(): ModuleLoader | null {
  for (const [path, load] of Object.entries(AI_MODULES as Record<string, ModuleLoader>)) {
    if (path.endsWith('/ai/index.ts')) return load
  }
  return null
}

function isPort(value: unknown): value is StudioAiPort {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StudioAiPort>
  return typeof candidate.generateSvgArt === 'function' && typeof candidate.generateThreeScene === 'function'
}

/** 生成入口是否可用（同步判断，供 UI 首帧决定按钮状态）。 */
export function hasStudioAi(): boolean {
  return injected !== null || entryLoader() !== null
}

/** 解析端口：显式注入优先，其次动态 import `@/ai`。任何异常都退化为 null。 */
export async function getStudioAiPort(): Promise<StudioAiPort | null> {
  if (injected) return injected
  const load = entryLoader()
  if (!load) return null
  try {
    const mod = await load()
    return isPort(mod) ? mod : null
  } catch {
    return null
  }
}
