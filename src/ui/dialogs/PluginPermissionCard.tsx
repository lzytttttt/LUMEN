/**
 * PluginPermissionCard.tsx —— 安装权限卡（03 §3.3，安装时唯一的人类确认界面）。
 *
 * 规则（逐条对齐 03 §3.3 / §3.4）：
 * 1. 非敏感项默认勾选，可取消；取消即标记 denied（插件仍可安装，调用被拦）。
 * 2. 敏感项默认不勾选、折叠、带「敏感」徽标；首次展开显示「展开说明」正文（03 §3.2）。
 * 3. 有敏感项未勾选时主按钮文案 =「安装（不含敏感权限）」；全部同意 =「安装并启用」。
 * 4. Enter = 主按钮、Esc = 取消，焦点默认在主按钮。
 * 5. 升级：只列新增项 + 「其余权限不变」；拒绝新增项 → 主按钮禁用（E-PERM-02，旧版本不受影响）。
 *
 * 可测钩子（06 §3.1）：每行 `[data-permission]` + `data-granted="true|false"`。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { Button } from '@/ui/primitives'
import { useReturnFocus } from './useReturnFocus'
import { PluginModal } from './PluginModal'
import {
  CAPABILITY_META,
  isSensitiveCapability,
  isPluginError,
  pluginErrorKey,
  type Capability,
  type PluginPackagePreview,
} from '@/plugins/public'

export interface PermissionDecision {
  grants: Capability[]
  denied: Capability[]
  enable: boolean
}

export interface PluginPermissionCardProps {
  preview: PluginPackagePreview | null
  open: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: (decision: PermissionDecision) => void | Promise<void>
}

function sourceKey(installSource: PluginPackagePreview['installSource']): MessageKey {
  if (installSource === 'builtin') return 'plugin.source.builtin'
  if (installSource === 'url') return 'plugin.source.url'
  return 'plugin.source.file'
}

const ALL_CAPS = Object.keys(CAPABILITY_META) as Capability[]

export function PluginPermissionCard({ preview, open, busy, onCancel, onConfirm }: PluginPermissionCardProps) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  useReturnFocus(open)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [checked, setChecked] = useState<Set<Capability>>(new Set())
  const [expanded, setExpanded] = useState<Set<Capability>>(new Set())

  const capabilities = useMemo(() => preview?.manifest.capabilities ?? [], [preview])
  const isUpgrade = Boolean(preview?.existing)
  const added = useMemo(() => preview?.addedCapabilities ?? [], [preview])
  /** 升级时只展示新增项；首装展示全部。 */
  const shown = useMemo<Capability[]>(() => {
    if (!preview) return []
    if (isUpgrade) return added
    return capabilities
  }, [preview, isUpgrade, added, capabilities])

  useEffect(() => {
    if (!preview || !open) return
    const base = new Set<Capability>(preview.suggestedGrants)
    if (preview.existing) for (const cap of preview.existing.grants) base.add(cap)
    // 敏感项一律默认不勾（03 §3.3 规则 2）；升级新增敏感项同样默认不勾。
    const next = new Set<Capability>()
    for (const cap of base) if (!isSensitiveCapability(cap)) next.add(cap)
    setChecked(next)
    setExpanded(new Set())
  }, [preview, open])

  // 焦点默认在主按钮（A-40-01）；Modal 的 rAF 会把焦点放到 body 首个控件，
  // 这里在它之后再补一次（60ms > 一帧），确保 Enter 直接确认。
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => primaryRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [open])

  if (!preview) return null

  const manifest = preview.manifest
  const name = manifest.name[lang] ?? manifest.name.zh

  const uncheckedSensitive = shown.filter((cap) => isSensitiveCapability(cap) && !checked.has(cap))
  const uncheckedAdded = isUpgrade ? uncheckedSensitive.length > 0 : false
  const anySensitive = capabilities.some((cap) => isSensitiveCapability(cap))
  const installAll = !anySensitive || uncheckedSensitive.length === 0

  const toggle = (cap: Capability) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(cap)) next.delete(cap)
      else next.add(cap)
      return next
    })
  }

  const expand = (cap: Capability) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(cap)) next.delete(cap)
      else next.add(cap)
      return next
    })
  }

  const confirm = () => {
    if (uncheckedAdded || busy) return
    const grants = ALL_CAPS.filter((cap) => capabilities.includes(cap) && checked.has(cap))
    const denied = ALL_CAPS.filter((cap) => capabilities.includes(cap) && !checked.has(cap))
    void onConfirm({ grants, denied, enable: preview.trust !== 'builtin' })
  }

  const primaryLabel = isUpgrade
    ? t('plugin.action.install')
    : installAll
      ? t('plugin.action.installEnable')
      : t('plugin.action.installWithoutSensitive')

  const header = isUpgrade
    ? t('plugin.install.updateTitle', { name, version: manifest.version })
    : t('plugin.install.title', { name })

  return (
    <PluginModal
      open={open}
      onClose={onCancel}
      title={header}
      subtitle={
        isUpgrade
          ? t('plugin.install.updateNewPermission', { name, version: manifest.version, count: added.length })
          : undefined
      }
      size="md"
      closeLabel={t('common.action.cancel')}
      dataHooks={{ 'data-plugin-permission-card': '1' }}
      initialFocus={primaryRef}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <button
            ref={primaryRef}
            type="button"
            className="lm-btn lm-btn--primary"
            disabled={busy || uncheckedAdded}
            onClick={confirm}
            data-plugin-install-confirm="1"
          >
            {busy ? t('plugin.install.installing') : primaryLabel}
          </button>
        </>
      }
    >
      <div className="plug-perm-card" data-plugin-id={manifest.id}>
        <div className="plug-perm-card__auth">
          <span>{t('plugin.manager.author', { name: manifest.author.name })}</span>
          <span>·</span>
          <span>{t('plugin.manager.version', { version: manifest.version })}</span>
          <span>·</span>
          <span className="plug-badge">{t(sourceKey(preview.installSource))}</span>
          {preview.trust !== 'builtin' ? <span className="plug-badge">{t('plugin.source.unsigned')}</span> : null}
          {preview.sourceUrl ? <span className="plug-muted">{preview.sourceUrl}</span> : null}
        </div>

        <div className="plug-perm-card__group-title">
          {isUpgrade ? t('plugin.permission.diffTitle') : t('plugin.permission.title')}
          {isUpgrade && added.length === 0 ? (
            <span className="plug-perm-card__diff">{t('plugin.permission.unchanged')}</span>
          ) : null}
        </div>

        <div className="plug-perm-card__list">
          {shown.length === 0 ? <p className="plug-perm-card__note">{t('plugin.permission.none')}</p> : null}
          {shown.map((cap) => {
            const meta = CAPABILITY_META[cap]
            const granted = checked.has(cap)
            const sensitive = isSensitiveCapability(cap)
            return (
              <div
                key={cap}
                className={sensitive ? 'plug-perm plug-perm--sensitive' : 'plug-perm'}
                data-permission={cap}
                data-granted={granted ? 'true' : 'false'}
              >
                <div className="plug-perm__main">
                  <label className="plug-perm__label">
                    <input
                      type="checkbox"
                      checked={granted}
                      onChange={() => toggle(cap)}
                      aria-label={t('plugin.a11y.permissionCard')}
                    />
                    <span>{t(meta.labelKey as MessageKey)}</span>
                    {sensitive ? <span className="plug-badge plug-badge--sensitive">{t('plugin.permission.sensitiveBadge')}</span> : null}
                  </label>
                  {sensitive && meta.detailKey ? (
                    <>
                      <button
                        type="button"
                        className="plug-perm__expand"
                        aria-expanded={expanded.has(cap)}
                        onClick={() => expand(cap)}
                      >
                        {expanded.has(cap) ? t('plugin.permission.collapse') : t('plugin.permission.expand')}
                      </button>
                      {expanded.has(cap) ? (
                        <span className="plug-perm__detail">{t(meta.detailKey as MessageKey)}</span>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="plug-perm__control">
                  <span className="plug-muted">{granted ? t('plugin.permission.granted') : t('plugin.permission.denied')}</span>
                </div>
              </div>
            )
          })}
        </div>

        {isUpgrade ? <p className="plug-perm-card__note">{t('plugin.permission.diffUnchanged')}</p> : null}
        {anySensitive ? <p className="plug-perm-card__note">{t('plugin.permission.installHint')}</p> : null}

        <div className="plug-perm-card__wont">{t('plugin.permission.wont')}</div>
        {uncheckedAdded ? <p className="plug-perm-card__diff">{t('plugin.permission.needConfirm')}</p> : null}
        <p className="plug-perm-card__note">{t('plugin.permission.subtitle')}</p>
      </div>
    </PluginModal>
  )
}

/** 安装失败时把 `PluginError` → 用户可读文案（供调用方 toast）。 */
export function permissionErrorMessage(error: unknown): string {
  return isPluginError(error) ? pluginErrorKey(error.code) : 'plugin.error.unknown'
}
