/**
 * plugins/api/ai.ts —— `lumen.ai`（02 §5.2 / §5.3）。
 *
 * - `complete`：只走 `currentProvider()`（用户已配置端点），错误映射 `E-RUN-01` + 原 code 进 detail；
 *   返回值**不含** baseURL/apiKey/headers（S-40-04）；每次调用审计 `plugin.ai-invoke`（只记字节数与 cached）。
 * - `registerRecipe`：清单 `contributes.recipes` 是唯一真相（双注册 §6.9）；注册/反注册时调用
 *   `@/ai/recipes` 的 `installPluginRecipeResolver`，把 `ns/slug` 解析成宿主可用的 `Recipe`。
 *   ⚠ 帧内 `build` 是函数、不能过 RPC；宿主同步 compose 路径拿不到它（已报 Lead 的接口缺口），
 *   这里注册的宿主 Recipe 的 `build` 会走 `resolveRecipeOf` 的回落；异步执行路径见 `executePluginRecipe`。
 * - `registerPromptFragment`：只追加、不复制内置 12 配方。
 */
import { currentProvider, isAiError } from '@/ai/provider'
import { installPluginRecipeResolver, type Recipe } from '@/ai/recipes'
import type { RecipeContent } from '@/ai/types'
import type { RecipeId } from '@/schema/deck'
import { getRegisteredRecipes } from '../contributionBus'
import { appendAudit } from '../audit'
import { PluginError } from '../errors'
import type { LocalizedText } from '../types'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'
import { titlePairOf } from './util'

export interface RuntimeRecipe {
  pluginId: string
  recipeId: string
  namespace: string
  id: string
  title: LocalizedText
}

export interface PromptFragment {
  pluginId: string
  id: string
  title: LocalizedText
  text: string
  tasks: string[]
}

const recipes = new Map<string, RuntimeRecipe>()
const fragments = new Map<string, PromptFragment>()

/** 帧内 `build` 的执行器（由 PluginHost 安装：向帧发 `__runRecipe` 并等结果）。 */
export type PluginRecipeExecutor = (pluginId: string, recipeId: string, content: RecipeContent, themeId: string) => Promise<unknown>
let recipeExecutor: PluginRecipeExecutor | null = null

export function setPluginRecipeExecutor(executor: PluginRecipeExecutor | null): void {
  recipeExecutor = executor
}

/** 异步执行插件配方（creator/compose 的异步路径用；同步 `buildRecipe` 不走这里）。 */
export async function executePluginRecipe(recipeId: string, content: RecipeContent, themeId: string): Promise<unknown> {
  const recipe = recipes.get(recipeId)
  if (!recipe) throw new PluginError('E-ABI-01', `recipe "${recipeId}" is not registered`)
  if (!recipeExecutor) throw new PluginError('E-HOST-01', 'plugin recipe executor is not installed')
  return recipeExecutor(recipe.pluginId, recipeId, content, themeId)
}

/* ------------------------------ resolver 装配 ------------------------------ */

function buildHostRecipe(recipe: RuntimeRecipe, slots: Recipe['slots']): Recipe {
  return {
    id: recipe.recipeId as RecipeId,
    slots,
    // 同步路径无法跨帧调用 build：抛出后由 `buildRecipe` 的 catch 回落 statement（02 §9.2 的最终回落）。
    build: () => {
      throw new PluginError('E-ABI-01', `plugin recipe "${recipe.recipeId}" requires frame execution`)
    },
  }
}

/** 重新安装 resolver：plugin recipe → 内置 12 → statement（02 §9.2 的唯一入口）。 */
export function refreshPluginRecipeResolver(): void {
  if (recipes.size === 0) {
    installPluginRecipeResolver(null)
    return
  }
  installPluginRecipeResolver((recipeId: string): Recipe | undefined => {
    const recipe = recipes.get(recipeId)
    if (!recipe) return undefined
    const declared = getRegisteredRecipes().find((entry) => entry.recipeId === recipeId && entry.pluginId === recipe.pluginId)
    const slots = declared?.declaration.slots ?? [{ key: 'headline', required: true }]
    return buildHostRecipe(recipe, slots)
  })
}

/* ------------------------------ 方法 ------------------------------ */

export async function handleAi(method: string, payload: unknown, call: ApiCall): Promise<unknown> {
  const { pluginId } = call.frame
  switch (method) {
    case 'complete': {
      const body = assertRecord(payload, 'payload')
      const system = typeof body.system === 'string' ? body.system.slice(0, 20_000) : ''
      const user = typeof body.user === 'string' ? body.user.slice(0, 20_000) : ''
      if (!system || !user) throw abiError('ai.complete requires system and user')
      const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? Math.min(2, Math.max(0, body.temperature)) : undefined
      const provider = currentProvider()
      const startedAt = Date.now()
      try {
        const result = await provider.complete({
          system,
          user,
          json: body.json === true,
          temperature,
          task: body.task === 'plugin' ? 'plugin' : undefined,
        })
        appendAudit({
          action: 'plugin.ai-invoke',
          actor: 'plugin',
          result: 'ok',
          pluginId,
          detail: `provider:${provider.id} promptBytes:${system.length + user.length} cached:${result.cached === true ? '1' : '0'} ms:${Date.now() - startedAt}`,
        })
        const reply: { text: string; model?: string; cached?: boolean; usage?: { prompt: number; completion: number } } = {
          text: result.text,
        }
        if (result.model !== undefined) reply.model = result.model
        if (result.cached !== undefined) reply.cached = result.cached
        if (result.usage) reply.usage = { prompt: result.usage.prompt, completion: result.usage.completion }
        return reply
      } catch (error) {
        const detail = isAiError(error) ? error.code : 'unknown'
        appendAudit({
          action: 'plugin.ai-invoke',
          actor: 'plugin',
          result: 'error',
          pluginId,
          code: 'E-RUN-01',
          detail: `provider:${provider.id} aiCode:${detail}`,
        })
        throw new PluginError('E-RUN-01', 'ai provider call failed', `aiCode:${detail}`)
      }
    }
    case 'registerRecipe': {
      const body = assertRecord(payload, 'payload')
      const id = typeof body.id === 'string' ? body.id : ''
      const namespace = typeof body.namespace === 'string' ? body.namespace : ''
      if (!id || !namespace) throw abiError('recipe id/namespace are required')
      const recipeId = `${namespace}/${id}`
      if (body.remove === true) {
        routesDelete(pluginId, recipeId)
        refreshPluginRecipeResolver()
        return null
      }
      const declared = getRegisteredRecipes().find((entry) => entry.recipeId === recipeId)
      if (!declared) throw abiError(`recipe "${recipeId}" is not declared in contributes.recipes`)
      const existing = recipes.get(recipeId)
      // 同一插件多帧 boot 时重复注册同 id：幂等覆盖（清单声明仍旧是唯一真相）；跨插件冲突拒绝。
      if (existing && existing.pluginId !== pluginId) throw abiError(`recipe "${recipeId}" is already registered`)
      recipes.set(recipeId, { pluginId, recipeId, namespace, id, title: titlePairOf(body.title) })
      refreshPluginRecipeResolver()
      return null
    }
    case 'registerPromptFragment': {
      const body = assertRecord(payload, 'payload')
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw abiError('prompt fragment id is required')
      if (body.remove === true) {
        fragments.delete(`${pluginId}#${id}`)
        return null
      }
      const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : ''
      if (!text) throw abiError('prompt fragment text is required')
      fragments.set(`${pluginId}#${id}`, {
        pluginId,
        id,
        title: titlePairOf(body.title),
        text,
        tasks: Array.isArray(body.tasks) ? body.tasks.filter((task): task is string => typeof task === 'string').slice(0, 4) : [],
      })
      return null
    }
    default:
      throw abiError(`unknown ai method "${method}"`)
  }
}

function routesDelete(pluginId: string, recipeId: string): void {
  const existing = recipes.get(recipeId)
  if (existing && existing.pluginId === pluginId) recipes.delete(recipeId)
}

/** 运行期注册的配方（供 verifyCodeRegistrations 校验双注册）。 */
export function registeredRecipeIds(pluginId: string): string[] {
  return [...recipes.values()].filter((recipe) => recipe.pluginId === pluginId).map((recipe) => recipe.recipeId)
}

export function listPluginRecipes(): RuntimeRecipe[] {
  return [...recipes.values()]
}

export function getPromptFragments(pluginId?: string): PromptFragment[] {
  return [...fragments.values()].filter((fragment) => (pluginId ? fragment.pluginId === pluginId : true))
}

export function clearPluginAiState(pluginId: string): void {
  for (const [key, recipe] of [...recipes.entries()]) {
    if (recipe.pluginId === pluginId) recipes.delete(key)
  }
  for (const [key, fragment] of [...fragments.entries()]) {
    if (fragment.pluginId === pluginId) fragments.delete(key)
  }
  refreshPluginRecipeResolver()
}

export function resetAiApiForTests(): void {
  recipes.clear()
  fragments.clear()
  recipeExecutor = null
  installPluginRecipeResolver(null)
}

export function registerAiApi(): void {
  registerNamespaceApi('ai', {
    complete: (payload, call) => handleAi('complete', payload, call),
    registerRecipe: (payload, call) => handleAi('registerRecipe', payload, call),
    registerPromptFragment: (payload, call) => handleAi('registerPromptFragment', payload, call),
  })
}
