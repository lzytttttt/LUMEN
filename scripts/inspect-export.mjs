import { readFileSync } from 'node:fs'
import path from 'node:path'

const file = process.argv[2] ?? 'harness/out/export/演示-该换一种载体了.html'
const html = readFileSync(path.resolve(file), 'utf8')

function jsonBlock(id) {
  const match = html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

const deckPayload = jsonBlock('lumen-deck')
const assets = jsonBlock('lumen-assets') ?? jsonBlock('lumen-asset-map') ?? {}
const deck = deckPayload?.deck ?? deckPayload
const assetCount = assets && typeof assets === 'object' ? Object.keys(assets).length : 0
const inlineScript = (html.match(/<script>([\s\S]*?)<\/script>/) ?? ['', ''])[1]

console.log(
  JSON.stringify(
    {
      sizeKB: Math.round(html.length / 1024),
      payloadKeys: deckPayload ? Object.keys(deckPayload) : null,
      slides: deck?.slides?.length,
      themeId: deck?.themeId,
      hasNotes: deck?.slides?.[0]?.notes !== undefined,
      assets: assetCount,
      assetBlockIds: [...html.matchAll(/id="(lumen-[a-z-]+)"/g)].map((m) => m[1]),
      scriptTags: (html.match(/<script/g) ?? []).length,
      styleTags: (html.match(/<style/g) ?? []).length,
      inlinePlayerKB: Math.round(inlineScript.length / 1024),
      externalRefs: [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]).slice(0, 5),
    },
    null,
    2,
  ),
)
