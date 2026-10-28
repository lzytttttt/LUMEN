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
  type ForgeTierSetting,
  type LlmProviderId,
  type UiTheme,
} from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { resetProgress } from '@/forge/game/progress'
import { downloadDiagnostics } from '@/forge/diagnostics'
import { PRESETS, applyPreset, type PresetId } from '@/ai/presets'
import { APP_VERSION } from '@/version'
import {
  Button,
  Field,
  NumberInput,
  Row,
  Section,
  Segmented,
  Select,
  Switch,
  TextInput,
} from '@/ui/primitives'
import { Modal } from '@/ui/primitives/Modal'

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
  const forge = useSettingsStore((s) => s.forge)
  const patchForge = useSettingsStore((s) => s.patchForge)
  const pushToast = useUiStore((s) => s.pushToast)
  const openDialog = useUiStore((s) => s.openDialog)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [resetArmed, setResetArmed] = useState(false)

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
        <Field label={t('ai.panel.channel')} hint={t('ai.panel.mockHint')}>
          <Select
            value={(llm.presetId ?? '') as PresetId | ''}
            onValueChange={(id) => {
              if (id === '') return
              patchLlm(applyPreset(llm, id))
            }}
            options={[
              ...(llm.presetId ? [] : [{ value: '' as const, label: t('ai.panel.presetCustom') }]),
              ...PRESETS.map((preset) => ({
                value: preset.id,
                label: t(preset.labelKey as 'ai.panel.preset.mock'),
              })),
            ]}
          />
        </Field>

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

        <Field label={t('ai.panel.format.title')}>
          <Segmented
            value={llm.format}
            block
            onValueChange={(format) => patchLlm({ format: format as typeof llm.format })}
            options={[
              { value: 'auto', label: t('ai.panel.format.auto') },
              { value: 'json', label: t('ai.panel.format.json') },
              { value: 'strict', label: t('ai.panel.format.strict') },
              { value: 'none', label: t('ai.panel.format.off') },
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

      <Section title={t('forge.settings.title')}>
        <Row cols={2}>
          <Field label={t('forge.settings.tier')} hint={t('forge.settings.lockTier')}>
            <Segmented
              value={forge.tier}
              block
              onValueChange={(tier) => patchForge({ tier: tier as ForgeTierSetting })}
              options={[
                { value: 'auto', label: t('forge.settings.tierAuto') },
                { value: 'L3', label: t('forge.assemble.tier.l3') },
                { value: 'L2', label: t('forge.assemble.tier.l2') },
                { value: 'L1', label: t('forge.assemble.tier.l1') },
                { value: 'L0', label: t('forge.assemble.tier.l0') },
              ]}
            />
          </Field>
          <Field label={t('forge.settings.gameplay')}>
            <Segmented
              value={forge.gameplay}
              block
              onValueChange={(gameplay) => patchForge({ gameplay: gameplay as 'min' | 'full' })}
              options={[
                { value: 'min', label: t('forge.settings.gameplayMin') },
                { value: 'full', label: t('forge.settings.gameplayFull') },
              ]}
            />
          </Field>
        </Row>

        <Row cols={2}>
          <Field label={t('forge.settings.sound')}>
            <Switch
              checked={forge.sound}
              label={t('forge.settings.sound')}
              onCheckedChange={(sound) => patchForge({ sound })}
            />
          </Field>
          <Field label={t('forge.settings.autoPremiere')}>
            <Switch
              checked={forge.autoPremiere}
              label={t('forge.settings.autoPremiere')}
              onCheckedChange={(autoPremiere) => patchForge({ autoPremiere })}
            />
          </Field>
        </Row>

        <Row cols={2}>
          <Field label={t('forge.settings.stream')}>
            <Switch
              checked={llm.stream}
              label={t('forge.settings.stream')}
              onCheckedChange={(stream) => patchLlm({ stream })}
            />
          </Field>
          <div className="ldlg-actions">
            <Button
              variant="outline"
              onClick={() => {
                if (!resetArmed) {
                  setResetArmed(true)
                  window.setTimeout(() => setResetArmed(false), 3000)
                  return
                }
                setResetArmed(false)
                void resetProgress().then(() => pushToast({ kind: 'success', message: t('forge.settings.resetDone') }))
              }}
            >
              {resetArmed ? t('forge.settings.resetConfirm') : t('forge.settings.reset')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                downloadDiagnostics()
                pushToast({ kind: 'success', message: t('forge.settings.diagnosticsDone') })
              }}
            >
              {t('forge.settings.diagnostics')}
            </Button>
          </div>
        </Row>
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
