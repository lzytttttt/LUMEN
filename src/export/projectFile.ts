/** projectFile.ts —— .lumen.json 工程文件的导入/导出（资源内联为 dataURL）。 */
import { collectAssetDataUrls } from '@/assets/assetStore'
import type { Block, Deck } from '@/schema/deck'
import { deckFileSchema } from '@/schema/deck'
import { slugify } from '@/schema/ids'
import { getAssetMeta, putAssetFromDataUrl } from '@/assets/assetStore'
import { parseDeckFile } from '@/schema/migrate'

export function collectAssetIds(deck: Deck): string[] {
  const ids: string[] = []
  for (const slide of deck.slides) {
    for (const block of slide.blocks) {
      const assetId = assetIdOf(block)
      if (assetId) ids.push(assetId)
      if (block.type === 'three' && block.posterAssetId) ids.push(block.posterAssetId)
    }
  }
  return ids
}

function assetIdOf(block: Block): string | null {
  if (block.type === 'image') return block.assetId
  return null
}

export async function buildProjectFile(deck: Deck) {
  const assets = await collectAssetDataUrls(collectAssetIds(deck))
  return deckFileSchema.parse({
    kind: 'lumen.deck',
    schemaVersion: deck.schemaVersion,
    exportedAt: Date.now(),
    deck,
    assets,
  })
}

export async function exportProjectFile(deck: Deck): Promise<void> {
  const file = await buildProjectFile(deck)
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  triggerDownload(blob, `${slugify(deck.title)}.lumen.json`)
}

export interface ImportResult {
  deck: Deck
  assets: Record<string, string>
  issueCount: number
}

export async function readProjectFileText(text: string): Promise<ImportResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const outcome = parseDeckFile(parsed)
  if (!outcome.ok || !outcome.value) {
    throw new Error(outcome.issues.join('；') || '文件结构不符合约定')
  }
  const assets = outcome.value.assets ?? {}
  await Promise.all(
    Object.entries(assets).map(async ([id, dataUrl]) => {
      const existing = await getAssetMeta(id)
      if (!existing) await putAssetFromDataUrl(id, dataUrl)
    }),
  )
  return { deck: outcome.value.deck, assets, issueCount: outcome.issues.length }
}

export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function openFilePicker(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}
