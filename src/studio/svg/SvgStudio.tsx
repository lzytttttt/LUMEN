/**
 * svg/SvgStudio.tsx —— SVG 工作室（全屏 Modal 里的编辑体验）。
 *
 * 信息架构：
 *   顶部  一句话生成（AI 端口）/ 视图框 / 动效 / 调色与格式化 / 文件动作
 *   左列  预览（净化产物 + 选中高亮 + 动效） + 源码编辑器（CodeEditor，300ms 防抖预览）
 *   右列  元素树 + 节点属性 + 安全检查（issues）
 *   底部  精选库 12 件 + 取消 / 应用到画布
 *
 * 数据纪律：
 * - 保留用户原文；只有「应用到画布」才用净化结果写块（失败则完全不碰画布）；
 * - 结构编辑作用于净化产物，并把源码规范化为净化后的形式（右列有明确提示）；
 * - 新建走 `blockOps.add(makeSvg)`，编辑走 `blockOps.replace`（id/几何不变，只换 source/viewBox/animate）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react'
import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  EyeOff,
  Palette,
  Upload,
} from 'lucide-react'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import type { SvgBlock, ThemeColors } from '@/schema/deck'
import { blankSvgSource, makeSvg } from '@/schema/factory'
import { shortHash } from '@/schema/ids'
import { blockOps } from '@/state/ops'
import { useActiveSlide, useDeckTheme, useThemeOverrides } from '@/state/selectors'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { parseColor } from '@/lint/color'
import { themeCssVars } from '@/themes'
import { Button, Field, NumberInput, Row, Section, Segmented, Select, Slider, Switch, TextInput } from '@/ui/primitives'
import { CodeEditor } from '@/ui/code/CodeEditor'
import { SVG_CATEGORIES, SVG_LIBRARY, svgLibraryByCategory, type SvgLibraryItem } from '@/studio/library'
import { rectForAspect } from '@/studio/geometry'
import { GenerateBar } from '../ai/GenerateBar'
import { getStudioAiPort } from '../ai/port'
import {
  analyzeSvg,
  DEFAULT_SVG_VIEW_BOX,
  diagnoseSvgSource,
  formatSvgMarkup,
  formatViewBox,
  measureContentViewBox,
  patchSvgNode,
  patchSvgViewBox,
  type SvgDiagnosis,
  type SvgNodeInfo,
  type SvgNodePatch,
  type ViewBoxTuple,
} from './document'
import { COLOR_TOKENS, expandThemeTokens, tokenizeSvgColors, type ThemeColorToken } from './colors'
import { SvgPreview } from './SvgPreview'

const MAX_SVG_BYTES = 512 * 1024
const ANIMATES: SvgBlock['animate'][] = ['none', 'float', 'pulse', 'spinSlow', 'draw']
const ANIMATE_KEYS: Record<SvgBlock['animate'], MessageKey> = {
  none: 'studio.svg.animateNone',
  float: 'studio.svg.animateFloat',
  pulse: 'studio.svg.animatePulse',
  spinSlow: 'studio.svg.animateSpin',
  draw: 'studio.svg.animateDraw',
}

const TRANSFORMS = ['none', 'flipH', 'flipV', 'rotate90', 'scaleUp', 'scaleDown'] as const
type TransformPreset = (typeof TRANSFORMS)[number]
const TRANSFORM_KEYS: Record<TransformPreset, MessageKey> = {
  none: 'studio.svg.transformClear',
  flipH: 'studio.svg.transformFlipH',
  flipV: 'studio.svg.transformFlipV',
  rotate90: 'studio.svg.transformRotate90',
  scaleUp: 'studio.svg.transformScaleUp',
  scaleDown: 'studio.svg.transformScaleDown',
}

interface Generation {
  provider: string
  model?: string
  promptDigest: string
}

export interface SvgStudioProps {
  /** 有值 = 编辑既有块；无值 = 新建流程。 */
  blockId?: string
  onClose: () => void
}

export function SvgStudio({ blockId, onClose }: SvgStudioProps) {
  const t = useT()
  const slide = useActiveSlide()
  const theme = useDeckTheme()
  const overrides = useThemeOverrides()
  const lang = useDeckStore((s) => s.deck?.lang ?? 'zh')
  const pushToast = useUiStore((s) => s.pushToast)

  const colors = useMemo<ThemeColors>(() => ({ ...theme.colors, ...(overrides ?? {}) }), [theme, overrides])
  const cssVars = useMemo(() => themeCssVars(theme, overrides), [theme, overrides])

  const existing = useMemo<SvgBlock | null>(() => {
    if (!blockId || !slide) return null
    const found = slide.blocks.find((block) => block.id === blockId)
    return found && found.type === 'svg' ? found : null
  }, [blockId, slide])

  const [source, setSource] = useState(() => existing?.source ?? blankSvgSource())
  const [animate, setAnimate] = useState<SvgBlock['animate']>(existing?.animate ?? 'none')
  const [libraryId, setLibraryId] = useState<string | undefined>(existing?.presetId)
  const [generation, setGeneration] = useState<Generation | null>(null)
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null)
  const [debounced, setDebounced] = useState(source)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 输入即预览：300ms 防抖，原文不动
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(source), 300)
    return () => window.clearTimeout(timer)
  }, [source])

  const diagnosis = useMemo<SvgDiagnosis>(() => diagnoseSvgSource(debounced), [debounced])
  const analysis = useMemo(() => (diagnosis.sanitized ? analyzeSvg(diagnosis.sanitized) : null), [diagnosis.sanitized])
  const viewBox: ViewBoxTuple = analysis?.viewBox ?? existing?.viewBox ?? DEFAULT_SVG_VIEW_BOX
  const previewMarkup = analysis?.annotated ?? ''
  const selectedNode = useMemo<SvgNodeInfo | null>(() => {
    if (!analysis || !selectedPath) return null
    return analysis.nodes.find((node) => samePath(node.path, selectedPath)) ?? null
  }, [analysis, selectedPath])
  const selectedIndex = selectedNode ? selectedNode.index : null

  // 结构变化后，选中的路径可能已经不存在
  useEffect(() => {
    if (!selectedPath || !analysis) return
    if (!analysis.nodes.some((node) => samePath(node.path, selectedPath))) setSelectedPath(null)
  }, [analysis, selectedPath])

  const toast = (kind: 'info' | 'success' | 'error', message: string) => pushToast({ kind, message })

  /* ------------------------------ 源码级动作 ------------------------------ */

  const replaceSource = (next: string | null): boolean => {
    if (next === null) return false
    setSource(next)
    return true
  }

  const applyNodePatch = (patch: SvgNodePatch) => {
    if (!selectedNode || !diagnosis.sanitized) return
    if (!replaceSource(patchSvgNode(diagnosis.sanitized, selectedNode.path, patch))) {
      toast('error', t('studio.common.blocked'))
    }
  }

  const setViewBoxPart = (index: number, value: number) => {
    if (!diagnosis.sanitized) return
    const next = [...viewBox] as ViewBoxTuple
    next[index] = value
    replaceSource(patchSvgViewBox(diagnosis.sanitized, next))
  }

  const fitViewBox = () => {
    if (!diagnosis.sanitized) return
    const measured = measureContentViewBox(diagnosis.sanitized)
    if (!measured) {
      toast('info', t('studio.svg.viewBoxAutoFailed'))
      return
    }
    replaceSource(patchSvgViewBox(diagnosis.sanitized, measured))
  }

  const tokenize = () => {
    if (!diagnosis.sanitized) return
    const result = tokenizeSvgColors(diagnosis.sanitized, colors)
    if (result.count === 0) {
      toast('info', t('studio.svg.tokenizeNone'))
      return
    }
    setSource(result.markup)
    toast('success', t('studio.svg.tokenized', { count: result.count }))
  }

  const expandTokens = () => {
    if (!diagnosis.sanitized) return
    const result = expandThemeTokens(diagnosis.sanitized, colors)
    if (result.count === 0) {
      toast('info', t('studio.svg.expandNone'))
      return
    }
    setSource(result.markup)
    toast('success', t('studio.svg.expanded', { count: result.count }))
  }

  const formatSource = () => {
    const result = formatSvgMarkup(source)
    if (!result) {
      toast('error', t('studio.common.blocked'))
      return
    }
    setSource(result.markup)
    toast('success', t('studio.svg.formatted'))
  }

  /* -------------------------------- 文件动作 ------------------------------- */

  const loadFile = async (file: File) => {
    if (file.size > MAX_SVG_BYTES) toast('info', t('studio.svg.sizeWarning'))
    try {
      const text = await file.text()
      setSource(text)
      setLibraryId(undefined)
      setGeneration(null)
      setSelectedPath(null)
    } catch (err) {
      toast('error', t('studio.common.uploadFailed', { message: messageOf(err) }))
    }
  }

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void loadFile(file)
  }

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!/<svg[\s>]/i.test(text)) {
        toast('info', t('studio.common.blocked'))
        return
      }
      setSource(text)
      setLibraryId(undefined)
      setGeneration(null)
    } catch (err) {
      toast('error', t('studio.common.uploadFailed', { message: messageOf(err) }))
    }
  }

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      toast('success', t('studio.common.copied'))
    } catch {
      toast('error', t('studio.common.copyFailed'))
    }
  }

  const downloadSource = () => {
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${libraryId ?? 'lumen-svg'}.svg`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const pickLibrary = (item: SvgLibraryItem) => {
    setSource(item.source)
    setLibraryId(item.id)
    setGeneration(null)
    setSelectedPath(null)
    toast('info', t('studio.svg.librarySelected'))
  }

  /* --------------------------------- AI --------------------------------- */

  const generate = async (prompt: string, signal: AbortSignal) => {
    const port = await getStudioAiPort()
    if (!port) throw new Error(t('studio.ai.notReady'))
    const result = await port.generateSvgArt(prompt, { signal })
    const cleaned = diagnoseSvgSource(result.source)
    if (!cleaned.ok) throw new Error(t('studio.ai.invalidSvg'))
    setSource(cleaned.sanitized)
    setLibraryId(undefined)
    setSelectedPath(null)
    setGeneration({ provider: result.provider, model: result.model, promptDigest: shortHash(prompt) })
    toast('success', t('studio.svg.generated'))
  }

  /* -------------------------------- 应用到画布 ------------------------------ */

  const apply = () => {
    const fresh = diagnoseSvgSource(source)
    if (!fresh.ok) {
      toast('error', t('studio.common.blocked'))
      return
    }
    const nextViewBox = fresh.viewBox ?? viewBox
    const provenance = {
      provider: generation?.provider ?? 'manual',
      model: generation?.model,
      promptDigest: generation?.promptDigest,
      at: Date.now(),
      note: generation ? 'svg-studio:ai' : 'svg-studio',
    }

    if (existing) {
      // 只换内容：id、几何、锁定态全部保留
      blockOps.replace({
        ...existing,
        source: fresh.sanitized,
        viewBox: nextViewBox,
        animate,
        presetId: libraryId,
        provenance,
      })
      toast('success', t('studio.svg.replaced'))
    } else {
      const rect = rectForAspect(760, nextViewBox[3] / nextViewBox[2])
      blockOps.add(
        makeSvg({
          ...rect,
          source: fresh.sanitized,
          viewBox: nextViewBox,
          animate,
          presetId: libraryId,
          provenance,
        }),
      )
      toast('success', t('studio.svg.created'))
    }
    onClose()
  }

  const issueCount = diagnosis.issues.length
  const statusWarn = !diagnosis.ok || issueCount > 0
  const statusLabel = statusWarn
    ? t('studio.svg.invalid', { count: Math.max(1, issueCount) })
    : t('studio.svg.valid')
  const libraryHint = libraryId
    ? (svgNameOf(libraryId, lang) ?? t('studio.svg.librarySelected'))
    : t('studio.svg.sourceHint')

  return (
    <div className="st-root st-svg">
      <GenerateBar kind="svg" onGenerate={generate} />

      <div className="st-svg__toolbar">
        <div className="st-tool">
          <span className="st-tool__label">{t('studio.svg.viewBox')}</span>
          <div className="st-tool__viewbox">
            <Row cols={4}>
              {[0, 1, 2, 3].map((index) => (
                <NumberInput
                  key={index}
                  value={viewBox[index]}
                  min={index >= 2 ? 1 : undefined}
                  disabled={!diagnosis.ok}
                  onValueChange={(value) => setViewBoxPart(index, value)}
                />
              ))}
            </Row>
          </div>
          <Button size="sm" variant="ghost" disabled={!diagnosis.ok} onClick={fitViewBox}>
            {t('studio.svg.viewBoxAuto')}
          </Button>
        </div>

        <div className="st-tool">
          <span className="st-tool__label">{t('studio.svg.presets')}</span>
          <Segmented
            value={animate}
            onValueChange={setAnimate}
            options={ANIMATES.map((item) => ({ value: item, label: t(ANIMATE_KEYS[item]) }))}
          />
        </div>

        <div className="st-tool st-tool--right">
          <span className={statusWarn ? 'st-status st-status--warn' : 'st-status st-status--ok'} title={t('studio.svg.issuesTitle')}>
            <span className="st-status__dot" />
            {statusLabel}
          </span>
          <Button size="sm" variant="ghost" icon={<Palette size={12} />} onClick={tokenize}>
            {t('studio.svg.tokenize')}
          </Button>
          <Button size="sm" variant="ghost" onClick={expandTokens}>
            {t('studio.svg.expandTokens')}
          </Button>
          <Button size="sm" variant="ghost" onClick={formatSource}>
            {t('studio.svg.format')}
          </Button>
          <span className="st-tool__sep" />
          <Button size="sm" variant="ghost" icon={<Upload size={12} />} onClick={() => fileRef.current?.click()}>
            {t('studio.svg.upload')}
          </Button>
          <Button size="sm" variant="ghost" icon={<ClipboardPaste size={12} />} onClick={() => void pasteFromClipboard()}>
            {t('studio.svg.paste')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copySource()}>
            {t('studio.svg.copySource')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={downloadSource}>
            {t('studio.svg.downloadSvg')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={onFileInput}
            aria-label={t('studio.svg.upload')}
          />
        </div>
      </div>

      <div className="st-svg__body">
        <div className="st-svg__left">
          <SvgPreview
            markup={previewMarkup}
            viewBox={viewBox}
            animate={animate}
            cssVars={cssVars}
            selectedIndex={selectedIndex}
            emptyLabel={issueCount > 0 ? t('studio.svg.invalid', { count: issueCount }) : t('studio.svg.dropHint')}
            onPickNode={(index) => {
              const node = analysis?.nodes[index]
              if (node) setSelectedPath(node.path)
            }}
            onDropFile={(file) => void loadFile(file)}
          />

          <div className="st-svg__editor">
            <div className="st-svg__editor-head">
              <span className="st-tool__label">{t('studio.svg.source')}</span>
              <span className="st-svg__bytes">{Math.round(diagnosis.bytes / 1024)}KB</span>
            </div>
            <CodeEditor
              value={source}
              language="svg"
              height="100%"
              ariaLabel={t('studio.svg.source')}
              onChange={(value) => setSource(value)}
            />
          </div>
        </div>

        <div className="st-svg__right lumen-scroll">
          <Section
            title={t('studio.svg.tree')}
            actions={<span className="st-chip">{analysis ? analysis.nodes.length : 0}</span>}
          >
            {analysis && analysis.nodes.length > 0 ? (
              <div className="st-tree" role="tree">
                {analysis.nodes.map((node) => (
                  <button
                    key={node.index}
                    type="button"
                    role="treeitem"
                    aria-selected={selectedPath !== null && samePath(node.path, selectedPath)}
                    className={
                      selectedPath !== null && samePath(node.path, selectedPath)
                        ? 'st-tree__row st-tree__row--active'
                        : 'st-tree__row'
                    }
                    style={{ paddingLeft: 4 + node.depth * 10 }}
                    onClick={() => setSelectedPath(node.path)}
                  >
                    <span className="st-tree__tag">{node.tag}</span>
                    <span className="st-tree__name">
                      {node.id ? `#${node.id}` : node.className ? `.${node.className.split(/\s+/)[0]}` : `#${node.index}`}
                    </span>
                    {node.hidden ? <EyeOff size={11} className="st-tree__hidden" /> : null}
                  </button>
                ))}
              </div>
            ) : (
              <p className="st-note">{t('studio.svg.noNodes')}</p>
            )}
            <p className="st-note st-note--dim">{t('studio.svg.treeHint')}</p>
          </Section>

          <Section title={t('studio.svg.nodeStyle')}>
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                viewBox={viewBox}
                onPatch={applyNodePatch}
              />
            ) : (
              <p className="st-note">{t('studio.svg.selectNode')}</p>
            )}
          </Section>

          <Section title={t('studio.svg.issuesTitle')} actions={<span className="st-chip">{issueCount}</span>}>
            {diagnosis.parseError ? (
              <p className="st-note st-note--warn">{t('studio.svg.parseError', { message: diagnosis.parseError })}</p>
            ) : null}
            {!diagnosis.ok && !diagnosis.parseError ? <p className="st-note st-note--warn">{t('studio.svg.empty')}</p> : null}
            {issueCount === 0 ? (
              <p className="st-note st-note--ok">{t('studio.svg.valid')}</p>
            ) : (
              <ul className="st-issues">
                {diagnosis.issues.map((issue, index) => (
                  <li key={`${issue.level}-${index}`} className="st-issues__row" data-level={issue.level}>
                    <span className="st-issues__level">
                      {t(`studio.svg.issueLevels.${issue.level}` as MessageKey)}
                    </span>
                    <span className="st-issues__msg">{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <div className="st-lib">
        <div className="st-lib__head">
          <span className="st-lib__title">{t('studio.svg.library')}</span>
          <span className="st-lib__hint lumen-truncate">{libraryHint}</span>
        </div>
        <div className="st-lib__strip lumen-scroll">
          {SVG_CATEGORIES.map((category) => (
            <div className="st-lib__group" key={category}>
              <span className="st-lib__cat">{t(`studio.library.${category}` as MessageKey)}</span>
              <div className="st-lib__row">
                {svgLibraryByCategory(category).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={libraryId === item.id ? 'st-lib__card st-lib__card--active' : 'st-lib__card'}
                    title={item.name[lang]}
                    aria-pressed={libraryId === item.id}
                    onClick={() => pickLibrary(item)}
                  >
                    <span
                      className="st-lib__art"
                      style={cssVars as CSSProperties}
                      dangerouslySetInnerHTML={{ __html: item.source }}
                    />
                    <span className="st-lib__name lumen-truncate">{item.name[lang]}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="st-actions">
        <span className="st-actions__info lumen-truncate">
          {existing ? t('studio.svg.subtitleEdit') : t('studio.svg.subtitleNew')}
          {` · ${t('studio.svg.viewBox')} ${formatViewBox(viewBox)}`}
          {generation ? ` · ${generation.provider}${generation.model ? `/${generation.model}` : ''}` : ''}
        </span>
        <span className="st-actions__spacer" />
        <Button variant="ghost" onClick={onClose}>
          {t('studio.common.cancel')}
        </Button>
        <Button
          variant="primary"
          icon={<Check size={13} />}
          disabled={!diagnosis.ok}
          title={diagnosis.ok ? undefined : t('studio.common.blocked')}
          onClick={apply}
        >
          {existing ? t('studio.svg.replace') : t('studio.svg.insert')}
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------ 节点属性面板 ------------------------------ */

function NodeInspector({
  node,
  viewBox,
  onPatch,
}: {
  node: SvgNodeInfo
  viewBox: ViewBoxTuple
  onPatch: (patch: SvgNodePatch) => void
}) {
  const t = useT()
  const [idDraft, setIdDraft] = useState(node.id ?? '')
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)

  useEffect(() => {
    setIdDraft(node.id ?? '')
  }, [node.index, node.id])

  useEffect(() => {
    setOpacityDraft(null)
  }, [node.index])

  const commitId = () => {
    const next = idDraft.trim()
    if (next === (node.id ?? '')) return
    onPatch({ id: next === '' ? null : next })
  }

  const transformValue = transformOf(node.transform, viewBox)
  const opacity = opacityDraft ?? (node.opacity ? Number.parseFloat(node.opacity) : 1)

  return (
    <div className="st-node">
      <Field label={t('studio.svg.nodeId')}>
        <TextInput
          value={idDraft}
          mono
          placeholder={`${node.tag}-1`}
          onValueChange={setIdDraft}
          onBlur={commitId}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitId()
            }
          }}
        />
      </Field>

      <Row cols={2}>
        <Field label={t('studio.svg.nodeFill')}>
          <PaintControl value={node.fill} onPatch={(fill) => onPatch({ fill })} />
        </Field>
        <Field label={t('studio.svg.nodeStroke')}>
          <PaintControl value={node.stroke} onPatch={(stroke) => onPatch({ stroke })} />
        </Field>
      </Row>

      <Field label={`${t('studio.svg.nodeOpacity')} · ${percentLabel(opacity)}`}>
        <Slider
          value={Number.isFinite(opacity) ? opacity : 1}
          min={0}
          max={1}
          step={0.01}
          ariaLabel={t('studio.svg.nodeOpacity')}
          onValueChange={(value) => {
            setOpacityDraft(value)
            onPatch({ opacity: value })
          }}
        />
      </Field>

      <Field label={t('studio.svg.nodeTransform')}>
        <Select<TransformPreset | 'custom'>
          value={transformValue}
          onValueChange={(preset) => {
            if (preset === 'custom') return
            onPatch({ transform: transformFor(preset, viewBox) })
          }}
          options={[
            ...TRANSFORMS.map((preset) => ({ value: preset, label: t(TRANSFORM_KEYS[preset]) })),
            ...(transformValue === 'custom' ? [{ value: 'custom' as const, label: 'custom' }] : []),
          ]}
        />
      </Field>

      <Field label={t('studio.svg.nodeHidden')}>
        <Switch checked={node.hidden} onCheckedChange={(hidden) => onPatch({ hidden })} label={t('studio.svg.nodeHidden')} />
      </Field>
    </div>
  )
}

function percentLabel(value: number): string {
  if (!Number.isFinite(value)) return '100%'
  return `${Math.round(value * 100)}%`
}

/* -------------------------------- 颜色控件 -------------------------------- */

const PAINT_OPTIONS_BASE = ['inherit', 'none', 'currentColor', 'literal'] as const
type PaintOption = (typeof PAINT_OPTIONS_BASE)[number] | `token:${ThemeColorToken}`

function paintKindOf(value: string | undefined): PaintOption {
  if (value === undefined || value.trim() === '') return 'inherit'
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  if (lower === 'none') return 'none'
  if (lower === 'currentcolor') return 'currentColor'
  const match = /^var\(\s*--d-([a-z0-9-]+)\s*\)$/i.exec(trimmed)
  if (match && (COLOR_TOKENS as readonly string[]).includes(match[1])) return `token:${match[1] as ThemeColorToken}`
  return 'literal'
}

function PaintControl({ value, onPatch }: { value: string | undefined; onPatch: (value: string | null) => void }) {
  const t = useT()
  const kind = paintKindOf(value)
  const literal = kind === 'literal' ? (value ?? '') : ''
  const [draft, setDraft] = useState(literal)

  useEffect(() => {
    setDraft(literal)
  }, [literal])

  const commit = () => {
    const next = draft.trim()
    if (next === '') {
      onPatch(null)
      return
    }
    if (!isPaintValue(next)) {
      setDraft(literal)
      return
    }
    onPatch(next)
  }

  return (
    <div className="st-paint">
      <Select<PaintOption>
        value={kind}
        onValueChange={(next) => {
          if (next === 'literal') return
          if (next === 'inherit') onPatch(null)
          else if (next === 'none') onPatch('none')
          else if (next === 'currentColor') onPatch('currentColor')
          else onPatch(`var(--d-${next.slice('token:'.length)})`)
        }}
        options={[
          { value: 'inherit', label: t('studio.svg.paintInherit') },
          { value: 'none', label: t('studio.svg.paintNone') },
          { value: 'currentColor', label: t('studio.svg.paintCurrent') },
          ...COLOR_TOKENS.map((token) => ({ value: `token:${token}` as PaintOption, label: token })),
          { value: 'literal', label: t('studio.svg.paintCustom') },
        ]}
      />
      <TextInput
        value={draft}
        mono
        placeholder={t('studio.svg.paintCustomHint')}
        aria-label={t('studio.svg.paintCustom')}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}

function isPaintValue(value: string): boolean {
  if (parseColor(value) !== null) return true
  if (/^(none|currentColor)$/i.test(value)) return true
  return /^var\(\s*--d-[a-z0-9-]+\s*\)$/i.test(value)
}

/* --------------------------------- 工具 --------------------------------- */

function samePath(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function transformFor(preset: TransformPreset, viewBox: ViewBoxTuple): string | null {
  const cx = round2(viewBox[0] + viewBox[2] / 2)
  const cy = round2(viewBox[1] + viewBox[3] / 2)
  switch (preset) {
    case 'flipH':
      return `translate(${round2(cx * 2)} 0) scale(-1 1)`
    case 'flipV':
      return `translate(0 ${round2(cy * 2)}) scale(1 -1)`
    case 'rotate90':
      return `rotate(90 ${cx} ${cy})`
    case 'scaleUp':
      return scaleAround(cx, cy, 1.25)
    case 'scaleDown':
      return scaleAround(cx, cy, 0.8)
    case 'none':
    default:
      return null
  }
}

function scaleAround(cx: number, cy: number, factor: number): string {
  return `translate(${round2(cx * (1 - factor))} ${round2(cy * (1 - factor))}) scale(${factor})`
}

function transformOf(transform: string | undefined, viewBox: ViewBoxTuple): TransformPreset | 'custom' {
  if (transform === undefined || transform.trim() === '') return 'none'
  for (const preset of TRANSFORMS) {
    if (transformFor(preset, viewBox) === transform.trim()) return preset
  }
  return 'custom'
}

function svgNameOf(id: string, lang: 'zh' | 'en'): string | null {
  const item = SVG_LIBRARY.find((entry) => entry.id === id)
  return item ? item.name[lang] : null
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message
  return String(err ?? 'unknown')
}
