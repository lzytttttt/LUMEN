/**
 * forge/stage/Materials.tsx —— 材料篮（v0.2.5 §1 动作 1、§3.6、§4）。
 *
 * 三条入口都只产出**文本**：粘贴（手写）/ 网址（记原串，不抓取）/ 文件（FileReader 读文本）。
 * 二进制解析（PDF/PPT）不在 v0.2.5 边界内（00 §6）：没有服务端，也不引 WASM 解析器。
 *
 * 硬约束（`tests/unit/forge-copy.test.ts` 按文件计数）：
 *   - 本文件的文字预算区块计数必须为 0 —— 标签一律走 ghost 级小字；
 *   - 文件选择框在这里，起念屏（Seed.tsx）的 `<input` 计数才能保持 1；
 *   - 钩子：`data-forge-materials`（根）/ `data-material-id` / `data-material-status`（每个 chip）。
 */
import { useCallback, useRef, useState } from 'react'
import { useT, type MessageKey } from '@/i18n'
import { MATERIAL_FILE_ACCEPT, MATERIAL_MAX, MATERIAL_TEXT_MAX, materialsSummary } from '../materials'
import type { ForgeMaterial, MaterialKind } from '../types'

export interface MaterialsProps {
  materials: ForgeMaterial[]
  /** 生成中禁止改材料（大纲已定，改料不会重排已生成的幕）。 */
  busy?: boolean
  onAdd: (input: { kind: MaterialKind; label: string; text: string }) => void
  onRemove: (id: string) => void
}

/** 三条入口的顺序即 §1 的顺序：粘贴 / 网址 / 文件。 */
const ENTRIES: { kind: MaterialKind; key: MessageKey }[] = [
  { kind: 'paste', key: 'forge.seed.materialPaste' },
  { kind: 'url', key: 'forge.seed.materialUrl' },
  { kind: 'file', key: 'forge.seed.materialFile' },
]

type Panel = 'none' | 'menu' | 'paste' | 'url'

/** 用户内容截 24 字符展示（§2 的 `ForgeMaterial.label` 约定）。 */
function showLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  return flat.length > 24 ? flat.slice(0, 24) : flat
}

export function Materials(props: MaterialsProps) {
  const t = useT()
  const [panel, setPanel] = useState<Panel>('none')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<MessageKey | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const full = props.materials.length >= MATERIAL_MAX
  const locked = Boolean(props.busy)

  const reset = useCallback(() => {
    setPanel('none')
    setDraft('')
  }, [])

  /** 三条入口共用的落料判据：满 5 条 → 已满；超过 4000 字 → 过长。 */
  const commit = useCallback(
    (kind: MaterialKind, label: string, text: string) => {
      if (props.materials.length >= MATERIAL_MAX) {
        setError('forge.error.materialLimit')
        return
      }
      if (text.length > MATERIAL_TEXT_MAX) {
        setError('forge.error.materialTooLong')
        return
      }
      if (text.trim() === '') return
      props.onAdd({ kind, label: label.trim() === '' ? text.slice(0, 24) : label, text })
      setError(null)
      reset()
    },
    [props, reset],
  )

  const onFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return
      if (props.materials.length >= MATERIAL_MAX) {
        setError('forge.error.materialLimit')
        return
      }
      const reader = new FileReader()
      reader.onerror = () => setError('forge.error.materialFailed')
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : ''
        if (text.trim() === '') {
          setError('forge.error.materialFailed')
          return
        }
        if (text.length > MATERIAL_TEXT_MAX) {
          setError('forge.error.materialTooLong')
          return
        }
        props.onAdd({ kind: 'file', label: file.name, text })
        setError(null)
        reset()
      }
      reader.readAsText(file)
    },
    [props, reset],
  )

  const pickEntry = (kind: MaterialKind) => {
    if (locked) return
    if (kind === 'file') {
      fileRef.current?.click()
      return
    }
    setPanel(kind)
    setDraft('')
  }

  return (
    <div
      className="forge-materials"
      data-forge-materials
      data-material-count={props.materials.length}
      data-material-full={full ? '1' : '0'}
      aria-label={materialsSummary(props.materials)}
    >
      <span className="forge-materials__label">{t('forge.seed.materials')}</span>

      {props.materials.map((material) => (
        <span key={material.id} className="forge-materials__chip" data-material-id={material.id} data-material-status={material.status}>
          <span className="forge-materials__name" title={material.label}>
            {showLabel(material.label)}
          </span>
          <button
            type="button"
            className="forge-materials__drop"
            tabIndex={-1}
            aria-label={t('forge.a11y.close')}
            disabled={locked}
            onClick={() => props.onRemove(material.id)}
          >
            ×
          </button>
        </span>
      ))}

      <button
        type="button"
        className={panel === 'menu' ? 'forge-materials__add is-on' : 'forge-materials__add'}
        data-material-add
        aria-expanded={panel === 'menu'}
        aria-label={t('forge.seed.materialAdd')}
        disabled={locked}
        onClick={() => {
          setError(null)
          setPanel(panel === 'menu' ? 'none' : 'menu')
        }}
      >
        {t('forge.seed.materialAdd')}
      </button>

      {panel === 'menu' ? (
        <span className="forge-materials__menu">
          {ENTRIES.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="forge-materials__entry"
              data-material-kind={entry.kind}
              onClick={() => pickEntry(entry.kind)}
            >
              {t(entry.key)}
            </button>
          ))}
        </span>
      ) : null}

      {panel === 'paste' || panel === 'url' ? (
        <span className="forge-materials__panel">
          <input
            className="forge-materials__field"
            data-material-field={panel}
            type="text"
            value={draft}
            maxLength={panel === 'paste' ? MATERIAL_TEXT_MAX : 400}
            spellCheck={false}
            autoComplete="off"
            placeholder={t(panel === 'paste' ? 'forge.seed.materialPaste' : 'forge.seed.materialUrl')}
            aria-label={t(panel === 'paste' ? 'forge.seed.materialPaste' : 'forge.seed.materialUrl')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // 起念屏的 Esc 是全台关闭：输入框里先吃掉它，避免打字一半整台退出。
                event.stopPropagation()
                event.preventDefault()
                setError(null)
                reset()
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                commit(panel, draft, draft)
              }
            }}
          />
          <button
            type="button"
            className="forge-materials__entry"
            data-material-confirm={panel}
            disabled={draft.trim() === ''}
            onClick={() => commit(panel, draft, draft)}
          >
            {t('forge.seed.materialAdd')}
          </button>
        </span>
      ) : null}

      {/* 文件入口：唯一的选择框在这里，Seed.tsx 的 `<input` 计数才守得住 1。 */}
      <input
        ref={fileRef}
        className="forge-materials__file"
        type="file"
        accept={MATERIAL_FILE_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />

      {error ? (
        <span className="forge-materials__error" data-material-error={error} role="alert">
          {t(error)}
        </span>
      ) : null}
    </div>
  )
}
