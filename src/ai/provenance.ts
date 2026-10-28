/**
 * provenance.ts —— AI 块的溯源与快照。
 *
 * - `provenance`：谁生成的、用哪个配方、提示词摘要、时间；
 * - `aiSnapshot`：生成那一刻的块 JSON，用于「还原 AI 版本」（ProvenanceBadge 消费）。
 */
import type { Block, RecipeId } from '@/schema/deck'

export interface StampMeta {
  provider: string
  model?: string
  recipeId: RecipeId
  /** shortHash(prompt) 的结果。 */
  promptDigest: string
  at?: number
}

const SNAPSHOT_LIMIT = 120_000

/** 给每个块打上溯源信息，并保存生成时的快照。 */
export function stampBlocks(blocks: Block[], meta: StampMeta): Block[] {
  const at = meta.at ?? Date.now()
  return blocks.map((block) => {
    const provenance = {
      provider: meta.provider,
      model: meta.model,
      recipeId: meta.recipeId,
      promptDigest: meta.promptDigest,
      at,
    }
    const snapshot = JSON.stringify({ ...block, provenance, aiSnapshot: undefined })
    return {
      ...block,
      provenance,
      aiSnapshot: snapshot.length <= SNAPSHOT_LIMIT ? snapshot : undefined,
    } as Block
  })
}
