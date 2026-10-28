/**
 * ai/GenerateBar.tsx —— 工作室顶部的「一句话生成」输入条（SVG / 3D 共用）。
 *
 * 只负责交互与状态：prompt、生成中进度、取消（AbortController）、错误文案。
 * 具体「生成结果怎么校验、怎么落预览」由两个工作室通过 `onGenerate` 决定。
 */
import { useEffect, useRef, useState } from 'react'
import { Sparkles, Wand2, X } from 'lucide-react'
import { useT } from '@/i18n'
import { Button, TextInput } from '@/ui/primitives'
import { getStudioAiPort, hasStudioAi } from './port'

export type GenerateKind = 'svg' | 'three'

export interface GenerateBarProps {
  kind: GenerateKind
  /** 生成实现：抛错即视为失败（错误文案由本组件统一渲染）。 */
  onGenerate: (prompt: string, signal: AbortSignal) => Promise<void>
  disabled?: boolean
}

export function GenerateBar({ kind, onGenerate, disabled }: GenerateBarProps) {
  const t = useT()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  // 同步先给一个乐观判断（文件存在即亮），再用真实解析校正（模块加载失败也算不可用）
  const [ready, setReady] = useState<boolean>(hasStudioAi())

  useEffect(() => {
    let alive = true
    void getStudioAiPort().then((port) => {
      if (alive) setReady(port !== null)
    })
    return () => {
      alive = false
    }
  }, [])

  // 生成中：秒表（只用于进度提示，不参与逻辑）
  useEffect(() => {
    if (!busy) return
    setSeconds(0)
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  // 关闭工作室时中止在途请求
  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [])

  const run = async () => {
    const text = prompt.trim()
    if (text === '' || busy) return
    if (!ready) {
      setError(t('studio.ai.notReady'))
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(null)
    try {
      await onGenerate(text, controller.signal)
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
      setError(aborted ? t('studio.ai.cancelled') : t('studio.ai.failed', { reason: messageOf(err) }))
    } finally {
      controllerRef.current = null
      setBusy(false)
    }
  }

  const cancel = () => {
    controllerRef.current?.abort()
  }

  const status = busy
    ? `${t(kind === 'svg' ? 'ai.panel.generatingSvg' : 'ai.panel.generatingThree')} ${t('studio.ai.generating', { seconds })}`
    : error ?? (ready ? t('studio.ai.previewOnly') : t('studio.ai.notReady'))

  return (
    <div className="st-gen" data-busy={busy ? 'true' : undefined} data-error={error ? 'true' : undefined}>
      <span className="st-gen__badge">
        <Sparkles size={12} />
        {t('studio.ai.title')}
      </span>
      <TextInput
        className="st-gen__input"
        value={prompt}
        onValueChange={setPrompt}
        placeholder={t(kind === 'svg' ? 'studio.ai.placeholderSvg' : 'studio.ai.placeholderThree')}
        aria-label={t('studio.ai.title')}
        disabled={disabled || busy}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void run()
          }
        }}
      />
      {busy ? (
        <Button size="sm" variant="outline" icon={<X size={12} />} onClick={cancel}>
          {t('studio.ai.cancel')}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          icon={<Wand2 size={12} />}
          disabled={disabled || !ready || prompt.trim() === ''}
          onClick={() => void run()}
        >
          {t(kind === 'svg' ? 'ai.panel.generateSvg' : 'ai.panel.generateThree')}
        </Button>
      )}
      <span className="st-gen__status" aria-live="polite">
        {status}
      </span>
    </div>
  )
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message
  const text = String(err ?? '').trim()
  return text === '' ? 'unknown' : text
}
