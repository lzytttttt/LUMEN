/**
 * plugins/api/export.ts —— `lumen.export` 的导出前钩子（02 §5.2 / §5.3；`export:hook`，敏感）。
 *
 * 只做**预检 + 静态资产注入**：不改导出 HTML 结构 / `STANDALONE_CSP` / 体积护栏（D-40-11）。
 * 预算：预检总 1000ms，超时跳过并给警告（`E-QUOTA-03`，不阻断导出，除非用户勾选严格）；
 * 资产只允许 `.svg/.png/.webp`、单文件 ≤256KB、总计 ≤1MB。
 */
import { getRegisteredExportHooks } from '../contributionBus'
import type { PreflightResult, StaticAsset } from '../types'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'

export const EXPORT_PREFLIGHT_BUDGET_MS = 1000
export const STATIC_ASSET_MAX_BYTES = 256 * 1024
export const STATIC_ASSET_TOTAL_MAX_BYTES = 1024 * 1024

export interface ExportHookRegistration {
  pluginId: string
  id: string
  kind: 'preflight' | 'assets'
}

const hooks = new Map<string, ExportHookRegistration>()

/** 帧内钩子执行器（由 PluginHost 安装：向帧发 `__preflight` / `__provideAssets`）。 */
export type ExportHookExecutor = (pluginId: string, kind: 'preflight' | 'assets', ctx?: unknown) => Promise<unknown>
let executor: ExportHookExecutor | null = null

export function setExportHookExecutor(next: ExportHookExecutor | null): void {
  executor = next
}

function hookId(pluginId: string, id: string): string {
  return `${pluginId}#${id}`
}

function isDeclared(pluginId: string, id: string, kind: 'preflight' | 'assets'): boolean {
  return getRegisteredExportHooks().some(
    (entry) => entry.pluginId === pluginId && entry.declaration.id === id && entry.declaration.kind === kind,
  )
}

export function handleExport(method: string, payload: unknown, call: ApiCall): unknown {
  const { pluginId } = call.frame
  switch (method) {
    case 'onPreflight':
    case 'provideStaticAssets': {
      const kind = method === 'onPreflight' ? 'preflight' : 'assets'
      const body = payload && typeof payload === 'object' ? assertRecord(payload, 'payload') : {}
      const declared = getRegisteredExportHooks().filter((entry) => entry.pluginId === pluginId && entry.declaration.kind === kind)
      const id = declared[0]?.declaration.id ?? kind
      if (body.remove === true) {
        hooks.delete(hookId(pluginId, id))
        return null
      }
      if (!isDeclared(pluginId, id, kind)) throw abiError(`export hook "${kind}" is not declared in contributes.exportHooks`)
      hooks.set(hookId(pluginId, id), { pluginId, id, kind })
      return null
    }
    default:
      throw abiError(`unknown export method "${method}"`)
  }
}

/** 已注册的钩子（诊断用）。 */
export function listExportHooks(pluginId?: string): ExportHookRegistration[] {
  return [...hooks.values()].filter((hook) => (pluginId ? hook.pluginId === pluginId : true))
}

export function registeredExportHookIds(pluginId: string): string[] {
  return listExportHooks(pluginId).map((hook) => hook.id)
}

/**
 * 运行导出前预检：并发执行，总预算 1000ms；单个钩子超时/抛错只跳过并给警告（不阻断导出）。
 * ctx 形状 = `{ deck: DeckSnapshot; themeId; slides: ReadonlySlideMeta[] }`（02 §5.3）。
 */
export async function runExportPreflight(ctx: unknown): Promise<{ results: PreflightResult[]; warnings: string[]; timedOut: boolean }> {
  const preflights = listExportHooks().filter((hook) => hook.kind === 'preflight')
  if (preflights.length === 0 || !executor) return { results: [], warnings: [], timedOut: false }
  const results: PreflightResult[] = []
  const warnings: string[] = []
  let timedOut = false
  const deadline = Date.now() + EXPORT_PREFLIGHT_BUDGET_MS
  await Promise.all(
    preflights.map(async (hook) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        warnings.push(`plugin ${hook.pluginId}: export preflight budget exhausted (E-QUOTA-03)`)
        return
      }
      try {
        const value = await Promise.race([
          executor?.(hook.pluginId, 'preflight', ctx) ?? Promise.resolve([]),
          new Promise((resolve) => setTimeout(() => resolve('__timeout__'), remaining)),
        ])
        if (value === '__timeout__') {
          timedOut = true
          warnings.push(`plugin ${hook.pluginId}: export preflight timed out (E-QUOTA-03)`)
          return
        }
        if (Array.isArray(value)) results.push(...normalizePreflightResults(hook.pluginId, value))
      } catch {
        warnings.push(`plugin ${hook.pluginId}: export preflight failed (E-QUOTA-03)`)
      }
    }),
  )
  return { results, warnings, timedOut }
}

function normalizePreflightResults(pluginId: string, value: unknown[]): PreflightResult[] {
  const results: PreflightResult[] = []
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const level = record.level === 'warn' ? 'warn' : 'info'
    const message = record.message
    if (!message || typeof message !== 'object') continue
    const localized = message as { zh?: unknown; en?: unknown }
    const result: PreflightResult = {
      level,
      message: {
        zh: typeof localized.zh === 'string' ? localized.zh.slice(0, 160) : '',
        en: typeof localized.en === 'string' ? localized.en.slice(0, 160) : '',
      },
    }
    if (typeof record.slideId === 'string') result.slideId = record.slideId
    results.push(result)
  }
  void pluginId
  return results
}

/** 收集静态资产：白名单 mime、单文件 ≤256KB、总计 ≤1MB。 */
export async function collectStaticAssets(): Promise<{ assets: StaticAsset[]; warnings: string[] }> {
  const providers = listExportHooks().filter((hook) => hook.kind === 'assets')
  if (providers.length === 0 || !executor) return { assets: [], warnings: [] }
  const assets: StaticAsset[] = []
  const warnings: string[] = []
  let total = 0
  for (const hook of providers) {
    try {
      const value = await executor(hook.pluginId, 'assets')
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const path = typeof record.path === 'string' ? record.path : ''
        const mime = typeof record.mime === 'string' ? record.mime : ''
        const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : ''
        if (!/\.(svg|png|webp)$/i.test(path) || !/^image\/(svg\+xml|png|webp)$/i.test(mime) || !dataUrl.startsWith('data:')) {
          warnings.push(`plugin ${hook.pluginId}: static asset rejected (${path || 'unnamed'})`)
          continue
        }
        const bytes = Math.floor((dataUrl.length * 3) / 4)
        if (bytes > STATIC_ASSET_MAX_BYTES || total + bytes > STATIC_ASSET_TOTAL_MAX_BYTES) {
          warnings.push(`plugin ${hook.pluginId}: static asset exceeds quota (${path})`)
          continue
        }
        total += bytes
        assets.push({ path, mime, dataUrl })
      }
    } catch {
      warnings.push(`plugin ${hook.pluginId}: static assets hook failed`)
    }
  }
  return { assets, warnings }
}

export function clearPluginExportHooks(pluginId: string): void {
  for (const [key, hook] of [...hooks.entries()]) {
    if (hook.pluginId === pluginId) hooks.delete(key)
  }
}

export function resetExportApiForTests(): void {
  hooks.clear()
  executor = null
}

export function registerExportApi(): void {
  registerNamespaceApi('export', {
    onPreflight: (payload, call) => handleExport('onPreflight', payload, call),
    provideStaticAssets: (payload, call) => handleExport('provideStaticAssets', payload, call),
  })
}
