/**
 * SettingsDialog.tsx —— 设置：语言、UI 主题、减少动效、模型端点、关于入口。
 * 所有配置写进 useSettingsStore（由 persistence/settingsSync 落盘），弹窗本身不另存状态。
 */
import { useState } from 'react'
import type { Lang } from '@/i18n'
import { LANGS, useT } from '@/i18n'
import {
  isLlmReady,
  maskKey,
  useSettingsStore,
  type LlmProviderId,
  type UiTheme,
} from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { Button, Field, NumberInput, Row, Section, Segmented, Switch, TextInput } from '@/ui/primitives'
import { Modal } from '@/ui/primitives/Modal'

const APP_VERSION = '0.1.0'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const setLang = useSettingsStore((s) => s.setLang)
  const uiTheme = useSettingsStore((s) => s.uiTheme)
  const setUiTheme = useSettingsStore((s) => s.setUiTheme)
  const reducedMotion = useSettingsStore((s) => s.reducedMotion)
  const setReducedMotion = useSettingsStore((s) => s.setReducedMotion)
  const llm = useSettingsStore((s) => s.llm)
  const patchLlm = useSettingsStore((s) => s.patchLlm)
  const openDialog = useUiStore((s) => s.openDialog)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8000)
    try {
      const base = llm.baseURL.trim().replace(/\/+$/, '')
      if (base === '') throw new Error(t('editor.dialog.endpointRequired'))
      const response = await fetch(`${base}/models`, {
        headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : undefined,
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setTestResult({ ok: true, text: t('ai.panel.testOk', { model: llm.model || 'endpoint' }) })
    } catch (error) {
      setTestResult({
        ok: false,
        text: t('ai.panel.testFail', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      window.clearTimeout(timer)
      setTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('common.label.settings')}
      subtitle={t('editor.dialog.settingsSubtitle')}
      size="md"
      closeLabel={t('common.action.close')}
      footer={
        <>
          <Button variant="ghost" onClick={() => openDialog('about')}>
            {t('editor.dialog.aboutEntry')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.action.close')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.action.done')}
          </Button>
        </>
      }
    >
      <Section title={t('editor.dialog.appearance')}>
        <Field label={t('common.label.uiLanguage')}>
          <Segmented
            value={lang}
            block
            onValueChange={(next) => setLang(next as Lang)}
            options={LANGS.map((item) => ({ value: item.id, label: item.label }))}
          />
        </Field>

        <Field label={t('common.label.theme')}>
          <Segmented
            value={uiTheme}
            block
            onValueChange={(next) => setUiTheme(next as UiTheme)}
            options={[
              { value: 'dark', label: t('editor.dialog.uiThemeDark') },
              { value: 'light', label: t('editor.dialog.uiThemeLight') },
              { value: 'system', label: t('editor.dialog.uiThemeSystem') },
            ]}
          />
        </Field>

        <Field label={t('editor.dialog.reduceMotion')} hint={t('editor.dialog.reduceMotionHint')}>
          <Switch
            checked={reducedMotion}
            label={t('editor.dialog.reduceMotion')}
            onCheckedChange={setReducedMotion}
          />
        </Field>
      </Section>

      <Section title={t('editor.dialog.modelSection')} actions={<span className="insp-char">LLM</span>}>
        <Field label={t('ai.panel.settingsTitle')} hint={t('ai.panel.mockHint')}>
          <Segmented
            value={llm.provider}
            block
            onValueChange={(provider) => patchLlm({ provider: provider as LlmProviderId })}
            options={[
              { value: 'mock', label: t('ai.panel.providerMock') },
              { value: 'openai', label: t('ai.panel.providerOpenai') },
            ]}
          />
        </Field>

        <Row cols={2}>
          <Field label={t('ai.panel.baseURL')} hint={t('editor.dialog.endpointHint')}>
            <TextInput
              value={llm.baseURL}
              placeholder="https://api.openai.com/v1"
              onValueChange={(baseURL) => patchLlm({ baseURL })}
            />
          </Field>
          <Field label={t('ai.panel.model')}>
            <TextInput
              value={llm.model}
              placeholder="gpt-4o-mini"
              onValueChange={(model) => patchLlm({ model })}
            />
          </Field>
        </Row>

        <Field
          label={t('ai.panel.apiKey')}
          hint={`${t('ai.panel.apiKeyHint')} ${maskKey(llm.apiKey) || t('editor.dialog.apiKeyEmpty')}`}
        >
          <TextInput
            value={llm.apiKey}
            type="password"
            placeholder="sk-…"
            autoComplete="off"
            onValueChange={(apiKey) => patchLlm({ apiKey })}
          />
        </Field>

        <Row cols={2}>
          <Field label={t('ai.panel.temperature')}>
            <NumberInput
              value={llm.temperature}
              min={0}
              max={2}
              step={0.1}
              onValueChange={(temperature) => patchLlm({ temperature })}
            />
          </Field>
          <Field label={t('ai.panel.jsonMode')}>
            <Switch
              checked={llm.jsonMode}
              label={t('ai.panel.jsonMode')}
              onCheckedChange={(jsonMode) => patchLlm({ jsonMode })}
            />
          </Field>
        </Row>

        <div className="ldlg-actions">
          <Button
            variant="outline"
            onClick={runTest}
            disabled={testing || !isLlmReady({ ...llm, provider: 'openai' })}
          >
            {testing ? t('ai.panel.testing') : t('ai.panel.test')}
          </Button>
          {testResult ? (
            <span
              className={testResult.ok ? 'ldlg-status ldlg-status--ok' : 'ldlg-status ldlg-status--error'}
              style={{ padding: '4px 8px' }}
            >
              {testResult.text}
            </span>
          ) : null}
        </div>
      </Section>

      <div className="ldlg-about-card">
        <span className="ldlg-about-card__logo">
          LUMEN<span>.</span>
        </span>
        <span className="ldlg-about-card__meta">
          {t('editor.dialog.aboutVersion', { version: APP_VERSION })} · {t('common.app.tagline')}
        </span>
        <Button size="sm" variant="ghost" onClick={() => openDialog('about')}>
          {t('common.action.learnMore')}
        </Button>
      </div>
    </Modal>
  )
}
