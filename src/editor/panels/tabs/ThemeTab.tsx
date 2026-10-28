/**
 * ThemeTab.tsx —— 主题页签：6 套主题卡片（实时渲染小预览）+ 强调色覆盖 + 恢复默认。
 */
import { RotateCcw } from 'lucide-react'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { THEMES } from '@/themes'
import { useT } from '@/i18n'
import { Button, Field, Section } from '@/ui/primitives'

export function ThemeTab() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const pushToast = useUiStore((s) => s.pushToast)
  // 主题名/气质属于界面铬，跟随 UI 语言；deck.lang 只决定幻灯片内容语言。
  const lang = useSettingsStore((s) => s.lang)
  const overrides = deck?.themeOverrides ?? {}
  const activeTheme = THEMES[deck?.themeId ?? 'noir'] ?? THEMES.noir
  const accentChoices = [activeTheme.colors.accent, activeTheme.colors.accent2, activeTheme.colors.fg]
  const accentValue = overrides.accent ?? activeTheme.colors.accent

  return (
    <>
      <Section title={t('editor.inspector.themePick')}>
        <div className="insp-theme-grid">
          {Object.values(THEMES).map((theme) => {
            const active = deck?.themeId === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                className={active ? 'insp-theme insp-theme--active' : 'insp-theme'}
                aria-pressed={active}
                title={theme.vibe?.[lang] ?? theme.name[lang]}
                onClick={() => {
                  deckOps.setTheme(theme.id)
                  pushToast({ kind: 'info', message: t('editor.toast.themeChanged') })
                }}
              >
                <span className="insp-theme__preview" style={{ background: theme.colors.bg }}>
                  <span className="insp-theme__bar" style={{ background: theme.colors.fg, width: '78%' }} />
                  <span className="insp-theme__bar insp-theme__bar--short" style={{ background: theme.colors.muted }} />
                  <span className="insp-theme__bar insp-theme__bar--short" style={{ background: theme.colors.accent, width: '30%' }} />
                  <span className="insp-theme__dots">
                    <span className="insp-theme__dot" style={{ background: theme.colors.accent }} />
                    <span className="insp-theme__dot" style={{ background: theme.colors.accent2 }} />
                    <span className="insp-theme__dot" style={{ background: theme.colors.line }} />
                  </span>
                </span>
                <span className="insp-theme__meta">
                  <span className="insp-theme__name">{theme.name[lang]}</span>
                  <span className="insp-theme__font">{fontLabel(theme.font.display)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section title={t('editor.inspector.themeAccent')}>
        <Field hint={t('editor.inspector.themeAccentHint')}>
          <div className="insp-accent-row">
            {accentChoices.map((color, index) => (
              <button
                key={`${color}-${index}`}
                type="button"
                className={
                  accentValue.toLowerCase() === color.toLowerCase()
                    ? 'insp-accent insp-accent--active'
                    : 'insp-accent'
                }
                style={{ background: color }}
                aria-label={`${t('editor.inspector.themeAccent')} ${index + 1}`}
                title={color}
                onClick={() => {
                  deckOps.setThemeOverride({ accent: color })
                  pushToast({ kind: 'info', message: t('editor.toast.themeAccent') })
                }}
              />
            ))}
            <input
              className="insp-accent-input"
              type="color"
              value={toHex(accentValue)}
              aria-label={t('editor.inspector.accentCustom')}
              title={t('editor.inspector.accentCustom')}
              onChange={(event) => deckOps.setThemeOverride({ accent: event.target.value })}
            />
          </div>
        </Field>
        <Button
          size="sm"
          variant="ghost"
          block
          icon={<RotateCcw size={13} />}
          onClick={() => {
            deckOps.resetThemeOverrides()
            pushToast({ kind: 'info', message: t('editor.toast.themeReset') })
          }}
        >
          {t('editor.inspector.themeReset')}
        </Button>
      </Section>
    </>
  )
}

/** 第一个字体族名（用于卡片上的一行小字）。 */
function fontLabel(stack: string): string {
  const first = stack.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
  return first === '' ? 'system-ui' : first
}

/** <input type="color"> 只吃 #rrggbb；主题里可能有 rgba/var，兜底成主题强调色。 */
function toHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#c8a15a'
}
