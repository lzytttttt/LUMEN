/**
 * InsertMenu.tsx —— 顶栏「插入」下拉：文本 / 形状 / 图片 / SVG / 3D / HTML。
 *
 * 所有插入动作都在 insertActions 里，落点由插入几何统一决定（安全区中心 + 自动选中）。
 * 3D 用 7 个 preset 缩略卡；SVG 支持空白、精选库、粘贴源码、上传 .svg（净化后建块）。
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { Code2, Image as ImageIcon, Type, Upload } from 'lucide-react'
import type { ThreePreset } from '@/schema/deck'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { useDeckStore } from '@/state/deckStore'
import { useThemeOverrides } from '@/state/selectors'
import { useUiStore } from '@/state/uiStore'
import { getTheme, themeCssVars } from '@/themes'
import { Popover } from '@/ui/primitives'
import { openFilePicker } from '@/export/projectFile'
import { SVG_LIBRARY, type SvgLibraryItem } from '@/studio/library'
import {
  insertBlankSvg,
  insertHtml,
  insertImageFromFile,
  insertLibrarySvg,
  insertShape,
  insertSvgSource,
  insertText,
  insertThree,
} from './insertActions'
import { SvgSourceDialog } from './SvgSourceDialog'
import './toolbar.css'

const SHAPES: { kind: 'rect' | 'ellipse' | 'line' | 'triangle' | 'rule'; labelKey: MessageKey }[] = [
  { kind: 'rect', labelKey: 'editor.insert.shapes.rect' },
  { kind: 'ellipse', labelKey: 'editor.insert.shapes.ellipse' },
  { kind: 'line', labelKey: 'editor.insert.shapes.line' },
  { kind: 'triangle', labelKey: 'editor.insert.shapes.triangle' },
  { kind: 'rule', labelKey: 'editor.insert.shapes.rule' },
]

const THREE_PRESETS: ThreePreset[] = ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe']

export function InsertMenu({
  open,
  anchor,
  onClose,
}: {
  open: boolean
  anchor: HTMLElement | null
  onClose: () => void
}) {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const overrides = useThemeOverrides()
  const pushToast = useUiStore((s) => s.pushToast)
  const [pasteOpen, setPasteOpen] = useState(false)

  const theme = getTheme(deck?.themeId)
  const svgVars = useMemo(() => themeCssVars(theme, overrides), [theme, overrides])
  const libraryByCategory = useMemo(() => {
    const groups = new Map<SvgLibraryItem['category'], SvgLibraryItem[]>()
    for (const item of SVG_LIBRARY) {
      const list = groups.get(item.category) ?? []
      list.push(item)
      groups.set(item.category, list)
    }
    return Array.from(groups.entries())
  }, [])

  const run = (action: () => void) => {
    action()
    onClose()
  }

  const uploadSvg = async () => {
    const file = await openFilePicker('.svg,image/svg+xml')
    if (!file) return
    if (file.size > 512 * 1024) {
      pushToast({ kind: 'error', message: t('editor.insert.fileTooLarge', { size: '512KB' }) })
      return
    }
    const text = await file.text()
    const issues = insertSvgSource(text)
    if (issues !== null && issues > 0) {
      pushToast({ kind: 'info', message: t('editor.insert.svgSanitized', { count: issues }) })
    }
    onClose()
  }

  const pickImage = async () => {
    const file = await openFilePicker('image/*')
    if (!file) return
    await insertImageFromFile(file)
    onClose()
  }

  return (
    <>
      <Popover open={open} onClose={onClose} anchor={anchor} width={340}>
        <div className="ins-menu">
          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.sections.text')}</div>
            <div className="ins-row">
              <button type="button" className="ins-card" onClick={() => run(() => insertText('body'))}>
                <Type size={13} />
                {t('editor.insert.text')}
              </button>
              <button type="button" className="ins-card" onClick={() => run(() => insertText('h1'))}>
                {t('editor.insert.heading')}
              </button>
              <button type="button" className="ins-card" onClick={() => run(() => insertText('lead'))}>
                {t('editor.insert.lead')}
              </button>
              <button type="button" className="ins-card" onClick={() => run(() => insertText('caption'))}>
                {t('editor.insert.caption')}
              </button>
            </div>
          </div>

          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.sections.shape')}</div>
            <div className="ins-shapes">
              {SHAPES.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  className="ins-shape"
                  title={t(item.labelKey)}
                  onClick={() => run(() => insertShape(item.kind))}
                >
                  <span className={`ins-shape__glyph ins-shape__glyph--${item.kind}`} />
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.sections.media')}</div>
            <button type="button" className="ins-card ins-card--block" onClick={pickImage}>
              <ImageIcon size={13} />
              {t('editor.insert.image')}
              <span className="ins-card__hint">jpg · png · webp</span>
            </button>
          </div>

          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.svg')}</div>
            <div className="ins-row">
              <button type="button" className="ins-card" onClick={() => run(() => insertBlankSvg())}>
                {t('editor.insert.blankSvg')}
              </button>
              <button
                type="button"
                className="ins-card"
                onClick={() => {
                  onClose()
                  setPasteOpen(true)
                }}
              >
                <Code2 size={13} />
                {t('editor.insert.pasteSvg')}
              </button>
              <button type="button" className="ins-card" onClick={uploadSvg}>
                <Upload size={13} />
                {t('editor.insert.uploadSvg')}
              </button>
            </div>

            <div className="ins-library">
              {libraryByCategory.length === 0 ? (
                <p className="insp-note">{t('editor.insert.libraryEmpty')}</p>
              ) : null}
              {libraryByCategory.map(([category, items]) =>
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="ins-library__row"
                    title={item.name.en}
                    onClick={() => run(() => insertLibrarySvg(item))}
                  >
                    <span
                      className="ins-library__preview"
                      style={
                        {
                          ...svgVars,
                          // 预览是 38×24 的缩略图，用更亮的墨色保证线描可见（不改主题令牌本身）。
                          '--d-line': theme.colors.muted,
                          '--d-muted': theme.colors.fg,
                        } as CSSProperties
                      }
                      dangerouslySetInnerHTML={{ __html: item.source }}
                    />
                    <span className="ins-library__name">{item.name[deck?.lang ?? 'zh']}</span>
                    <span className="ins-library__cat">
                      {t(`studio.library.${category}` as MessageKey)}
                    </span>
                  </button>
                )),
              )}
            </div>
          </div>

          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.three')}</div>
            <div className="ins-presets">
              {THREE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="ins-preset"
                  title={t(`studio.three.presets.${preset}` as MessageKey)}
                  onClick={() => run(() => insertThree(preset))}
                >
                  <span className="ins-preset__orb" />
                  {t(`studio.three.presets.${preset}` as MessageKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="ins-group">
            <div className="ins-group__title">{t('editor.insert.sections.block')}</div>
            <button type="button" className="ins-card ins-card--block" onClick={() => run(() => insertHtml())}>
              <Code2 size={13} />
              {t('editor.insert.html')}
              <span className="ins-card__hint">sandbox</span>
            </button>
          </div>

          <div className="ins-foot">{t('editor.insert.footHint')}</div>
        </div>
      </Popover>

      <SvgSourceDialog open={pasteOpen} onClose={() => setPasteOpen(false)} />
    </>
  )
}
