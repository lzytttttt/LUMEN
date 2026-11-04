/**
 * plugins/api/lint.ts —— `lumen.lint`（02 §5.2 / §5.3 / §4.5）。
 *
 * - `helpers` 是宿主纯函数的再导出（插件在帧内用的是同公式的本地实现，两边口径一致）；
 * - `registerRule` 的规则**必须已在清单 `contributes.lintRules` 声明**（清单是唯一真相，§6.9）；
 * - `run` 留在帧内，宿主经 `__runRule` 请求执行（50ms 预算 / 300ms 全 deck 预算由调用方计时）；
 * - `report` 是规则外的手动上报（口径补充 #2）。
 */
import { getRegisteredLintRules } from '../contributionBus'
import { contrastRatio } from '@/lint/color'
import { estimateTextLayout } from '@/lint/measure'
import { readingSeconds } from '@/lint/deckLint'
import { plainText } from '@/render/text/markdown'
import type { LintFinding, LocalizedText } from '../types'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'
import { titlePairOf } from './util'

export const LINT_RULE_BUDGET_MS = 50
export const LINT_DECK_BUDGET_MS = 300
export const LINT_MISS_LIMIT = 3

export interface CodeLintRule {
  pluginId: string
  id: string
  code: string
  title: LocalizedText
  severity: 'info' | 'warn' | 'error'
  timeouts: number
}

const rules = new Map<string, CodeLintRule>()
const manualFindings = new Map<string, LintFinding[]>()

/** 清单声明里是否有该规则（code = `<pluginId>/<id>`）。 */
export function isDeclaredLintRule(pluginId: string, ruleId: string): boolean {
  const code = `${pluginId}/${ruleId}`
  return getRegisteredLintRules().some((entry) => entry.code === code)
}

export function handleLint(method: string, payload: unknown, call: ApiCall): unknown {
  const { pluginId } = call.frame
  switch (method) {
    case 'registerRule': {
      const body = assertRecord(payload, 'payload')
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw abiError('lint rule id is required')
      if (body.remove === true) {
        rules.delete(`${pluginId}/${id}`)
        return null
      }
      if (!isDeclaredLintRule(pluginId, id)) {
        throw abiError(`lint rule "${id}" is not declared in contributes.lintRules`)
      }
      const severity = body.severity === 'error' || body.severity === 'info' ? body.severity : 'warn'
      const title = titlePairOf(body.title)
      if (!title.zh && !title.en) throw abiError('lint rule title is required')
      rules.set(`${pluginId}/${id}`, { pluginId, id, code: `${pluginId}/${id}`, title, severity, timeouts: 0 })
      return null
    }
    case 'report': {
      const body = assertRecord(payload, 'payload')
      const findings = Array.isArray(body.findings) ? body.findings.slice(0, 50) : []
      const normalized: LintFinding[] = []
      for (const item of findings) {
        const record = assertRecord(item, 'finding')
        const message = titlePairOf(record.message)
        if (!message.zh && !message.en) throw abiError('finding message is required')
        normalized.push({
          slideId: typeof record.slideId === 'string' ? record.slideId : undefined,
          blockId: typeof record.blockId === 'string' ? record.blockId : undefined,
          message,
          params: record.params && typeof record.params === 'object' ? (record.params as Record<string, string | number>) : undefined,
        })
      }
      manualFindings.set(pluginId, normalized)
      return null
    }
    default:
      throw abiError(`unknown lint method "${method}"`)
  }
}

/** 已注册的代码式 lint 规则（宿主 lint 面板/诊断用）。 */
export function listCodeLintRules(pluginId?: string): CodeLintRule[] {
  return [...rules.values()]
    .filter((rule) => (pluginId ? rule.pluginId === pluginId : true))
    .map((rule) => ({ ...rule }))
}

/** 规则超时计数 + 3 次自动停用（02 §4.5）。返回 true 表示已被停用。 */
export function noteLintTimeout(pluginId: string, ruleId: string): boolean {
  const rule = rules.get(`${pluginId}/${ruleId}`)
  if (!rule) return false
  rule.timeouts += 1
  if (rule.timeouts >= LINT_MISS_LIMIT) {
    rules.delete(`${pluginId}/${ruleId}`)
    return true
  }
  return false
}

export function getManualLintFindings(pluginId: string): LintFinding[] {
  return [...(manualFindings.get(pluginId) ?? [])]
}

export function clearPluginLintRules(pluginId: string): void {
  for (const [key, rule] of [...rules.entries()]) {
    if (rule.pluginId === pluginId) rules.delete(key)
  }
  manualFindings.delete(pluginId)
}

export function resetLintApiForTests(): void {
  rules.clear()
  manualFindings.clear()
}

/** 帧内 helpers 的宿主同源实现（口径一致：与 `src/lint/*` 同一函数）。 */
export const LINT_HELPERS = { plainText, contrastRatio, aaThreshold: null, estimateTextLayout, readingSeconds }

export function registerLintApi(): void {
  registerNamespaceApi('lint', {
    registerRule: (payload, call) => handleLint('registerRule', payload, call),
    report: (payload, call) => handleLint('report', payload, call),
  })
}
