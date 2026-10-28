/**
 * blocks/ImageView.tsx —— 图片块。
 *
 * 资产是 IndexedDB 里的 Blob（`useAssetUrl` 异步取 URL），所以这里必须处理三态：
 * 未取到（骨架/占位）→ 已加载 → 加载失败（回占位，不抛错、不阻塞导出）。
 */
import { useEffect, useState, type CSSProperties } from 'react'
import type { ImageBlock } from '@/schema/deck'
import { useAssetUrl } from '@/assets/assetStore'

export function ImageView({ block }: { block: ImageBlock }) {
  const url = useAssetUrl(block.assetId)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
  }, [url])

  const radius: CSSProperties | undefined = block.radius > 0 ? { borderRadius: block.radius } : undefined
  const state = url ? (loaded ? 'true' : 'false') : 'empty'

  return (
    <div className="lumen-image" data-fit={block.fit} data-image-state={state} style={radius}>
      {url ? (
        <img
          src={url}
          alt={block.alt ?? ''}
          draggable={false}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          style={{ objectFit: block.fit }}
        />
      ) : (
        <div className="lumen-image__empty">
          <span className="lumen-image__empty-label">{block.alt?.trim() || 'image'}</span>
        </div>
      )}
      {block.dim > 0 ? <div className="lumen-image__dim" style={{ opacity: block.dim }} /> : null}
      {block.caption ? (
        <div className="lumen-image__caption">
          <span>{block.caption}</span>
        </div>
      ) : null}
    </div>
  )
}
