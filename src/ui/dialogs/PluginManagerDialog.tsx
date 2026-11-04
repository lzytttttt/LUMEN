/**
 * PluginManagerDialog.tsx —— 插件管理弹窗（安装卡 / 权限卡 / 审计日志 / 隔离错误卡 /
 * 恢复默认工作台 / 安全模式 / 内存降级提示）。
 *
 * 契约：plan/v0.4.0/02 §6.10 / §7.4 / §7.7、03 §3.3–§3.5、§5.1–§5.3、06 §3.1。
 * 数据/动作全部来自 `@/plugins/public`（宿主唯一门面）；本文件不 import 插件运行时内部。
 *
 * 可测钩子（06 §3.1）：
 *   [data-plugin-id] / [data-plugin-state]（插件卡）、[data-permission][data-granted]（权限行）、
 *   [data-audit-count]（审计条数）、[data-storage-mode]（内存降级）、[data-lumen-safe]（由 boot/registry 写）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FolderOpen, Link2, RotateCcw, ShieldAlert } from 'lucide-react'
import type { MessageKey } from '@/i18n'
import { formatDate, useT } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { Button, TextInput } from '@/ui/primitives'
import { PluginModal } from './PluginModal'
import {
  CAPABILITY_META,
  PluginError,
  commitPluginInstall,
  disablePlugin,
  enablePlugin,
  enableSafeMode,
  grantCapability,
  installBuiltinSamples,
  isPluginError,
  isSensitiveCapability,
  loadPluginRuntime,
  preparePluginInstall,
  pluginErrorKey,
  resetWorkbench,
  retryPlugin,
  revokeCapability,
  uninstallPlugin,
  useAuditLog,
  useInstalledPlugins,
  usePluginsRevision,
  useSafeMode,
  useStorageMode,
  type AuditEntry,
  type Capability,
  type PluginErrorCode,
  type PluginSummary,
} from '@/plugins/public'
import { usePluginUiStore } from './pluginUiStore'
import { useReturnFocus } from './useReturnFocus'
import { PluginErrorCard } from './PluginErrorCard'
import { PluginPermissionCard, type PermissionDecision } from './PluginPermissionCard'
import './plugins.css'

/* ------------------------------ 小工具 ------------------------------ */

function errorMessageKey(error: unknown): MessageKey {
  const code = isPluginError(error)
    ? error.code
    : error instanceof PluginError
      ? error.code
      : 'E-HOST-01'
  return pluginErrorKey(code) as MessageKey
}

const AUDIT_ACTION_KEYS: Record<string, MessageKey> = {
  'plugin.install': 'plugin.audit.action.install',
  'plugin.enable': 'plugin.audit.action.enable',
  'plugin.disable': 'plugin.audit.action.disable',
  'plugin.uninstall': 'plugin.audit.action.uninstall',
  'plugin.denied': 'plugin.audit.action.denied',
  'plugin.error': 'plugin.audit.action.error',
  'plugin.quarantine': 'plugin.audit.action.quarantine',
  'plugin.retry': 'plugin.audit.action.retry',
  'plugin.permission-grant': 'plugin.audit.action.permissionGrant',
  'plugin.permission-revoke': 'plugin.audit.action.permissionRevoke',
  'plugin.frame-rejected': 'plugin.audit.action.frameRejected',
  'plugin.safe-mode-on': 'plugin.audit.action.safeModeOn',
  'plugin.reset': 'plugin.audit.action.reset',
  'creator.propose': 'plugin.audit.action.creatorPropose',
  'creator.trial': 'plugin.audit.action.creatorTrial',
  'creator.keep': 'plugin.audit.action.creatorKeep',
  'creator.revert': 'plugin.audit.action.creatorRevert',
  'creator.export': 'plugin.audit.action.creatorExport',
}

const AUDIT_ACTOR_KEYS: Record<AuditEntry['actor'], MessageKey> = {
  user: 'plugin.audit.actor.user',
  system: 'plugin.audit.actor.system',
  plugin: 'plugin.audit.actor.plugin',
  creator: 'plugin.audit.actor.creator',
}

const AUDIT_RESULT_KEYS: Record<AuditEntry['result'], MessageKey> = {
  ok: 'plugin.audit.result.ok',
  denied: 'plugin.audit.result.denied',
  error: 'plugin.audit.result.error',
  cancelled: 'plugin.audit.result.cancelled',
}

/** 审计动作 → 本地化描述；未知动作原样显示（不静默吞掉）。 */
function auditActionLabel(action: string): MessageKey | null {
  return AUDIT_ACTION_KEYS[action] ?? null
}

/* ============================== 挂载宿主 ============================== */

/**
 * PluginManagerHost —— 管理弹窗 + 权限卡的组合宿主（**懒加载**，02 §10.3 ≤14KB）。
 * 事件监听在常挂的 `PluginEventBridge` 里；本组件只在用户打开管理页/安装预览时加载。
 */
export function PluginManagerHost() {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const managerOpen = usePluginUiStore((s) => s.managerOpen)
  const closeManager = usePluginUiStore((s) => s.closeManager)
  const preview = usePluginUiStore((s) => s.preview)
  const setPreview = usePluginUiStore((s) => s.setPreview)
  const [busy, setBusy] = useState(false)

  const confirmInstall = async (decision: PermissionDecision) => {
    if (!preview) return
    setBusy(true)
    try {
      const outcome = await commitPluginInstall(preview, decision)
      setPreview(null)
      pushToast({
        kind: 'success',
        message: outcome.enabled ? t('plugin.install.success') : t('plugin.install.successDisabled'),
      })
    } catch (error) {
      pushToast({ kind: 'error', message: t(errorMessageKey(error)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PluginManagerDialog
        open={managerOpen}
        onClose={() => {
          // Esc 先关最上层的权限卡，再关管理弹窗（06 §6.1：Esc 一律先由宿主处理）。
          if (usePluginUiStore.getState().preview) {
            setPreview(null)
            return
          }
          closeManager()
        }}
      />
      <PluginPermissionCard
        preview={preview}
        open={preview !== null}
        busy={busy}
        onCancel={() => setPreview(null)}
        onConfirm={confirmInstall}
      />
    </>
  )
}

/* ============================== 管理弹窗 ============================== */

export function PluginManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  useReturnFocus(open)
  const patchPlugins = useSettingsStore((s) => s.patchPlugins)
  const pushToast = useUiStore((s) => s.pushToast)
  const plugins = useInstalledPlugins()
  const audit = useAuditLog()
  const revision = usePluginsRevision()
  const storageMode = useStorageMode()
  const safeMode = useSafeMode()
  const setPreview = usePluginUiStore((s) => s.setPreview)

  const [runtimeLoading, setRuntimeLoading] = useState(false)
  /** runtime 是否已注册（boot 在「无启用项」时同步早退，管理弹窗要负责补加载，02 §10.3）。 */
  const runtimeReady = revision > 0

  useEffect(() => {
    if (!open || runtimeReady) return
    let alive = true
    setRuntimeLoading(true)
    void loadPluginRuntime()
      .catch(() => null)
      .finally(() => {
        if (alive) setRuntimeLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, runtimeReady])

  const [busy, setBusy] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditFilter, setAuditFilter] = useState<string | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [urlConfirming, setUrlConfirming] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [uninstallTarget, setUninstallTarget] = useState<PluginSummary | null>(null)
  const [keepData, setKeepData] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetText, setResetText] = useState('')
  const [safeConfirmOpen, setSafeConfirmOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const byId = useMemo(() => {
    const map = new Map<string, PluginSummary>()
    for (const plugin of plugins) map.set(plugin.id, plugin)
    return map
  }, [plugins])

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length
  const filteredAudit = useMemo(
    () => (auditFilter ? audit.filter((entry) => entry.pluginId === auditFilter) : audit),
    [audit, auditFilter],
  )

  const run = async (label: string, action: () => Promise<unknown>, success?: MessageKey) => {
    setBusy(label)
    try {
      await action()
      if (success) pushToast({ kind: 'success', message: t(success) })
    } catch (error) {
      pushToast({ kind: 'error', message: t(errorMessageKey(error)) })
    } finally {
      setBusy(null)
    }
  }

  const pickFile = () => fileRef.current?.click()

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await run('prepare', async () => {
      const next = await preparePluginInstall({ file })
      setPreview(next)
    })
  }

  const openUrl = () => {
    setUrlOpen(true)
    setUrlConfirming(false)
  }

  const confirmUrl = async () => {
    const url = urlValue.trim()
    if (url === '') return
    setUrlConfirming(false)
    await run('prepare', async () => {
      const next = await preparePluginInstall({ url })
      setPreview(next)
      setUrlOpen(false)
      setUrlValue('')
    })
  }

  const installSamples = () =>
    void run(
      'samples',
      async () => {
        const results = await installBuiltinSamples()
        const failed = results.filter((item) => item.error)
        if (failed.length > 0 && failed[0].error) throw failed[0].error
      },
      'plugin.install.success',
    )

  const togglePermissions = (pluginId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
      return next
    })
  }

  const enableSafe = () =>
    void run('safe', async () => {
      await enableSafeMode()
      setSafeConfirmOpen(false)
      patchPlugins({ safeMode: true })
    }, 'plugin.safe.title')

  const disableSafe = () => {
    patchPlugins({ safeMode: false })
    pushToast({ kind: 'info', message: t('plugin.safe.exit') })
  }

  const doReset = () =>
    void run(
      'reset',
      async () => {
        await resetWorkbench()
        setResetOpen(false)
        setResetText('')
      },
      'plugin.reset.done',
    )

  const doUninstall = (target: PluginSummary) =>
    void run(
      'uninstall',
      async () => {
        await uninstallPlugin(target.id, { keepData })
        setUninstallTarget(null)
        setKeepData(false)
      },
      'plugin.uninstall.done',
    )

  const footer = (
    <>
      <Button variant="ghost" onClick={() => setSafeConfirmOpen(true)} disabled={safeMode}>
        <ShieldAlert size={13} /> {t('plugin.safe.pill')}
      </Button>
      <Button variant="ghost" onClick={() => setResetOpen(true)}>
        <RotateCcw size={13} /> {t('plugin.action.reset')}
      </Button>
      <span className="plugm__bar-spacer" />
      <Button variant="primary" onClick={onClose}>
        {t('common.action.done')}
      </Button>
    </>
  )

  return (
    <PluginModal
      open={open}
      onClose={onClose}
      title={t('plugin.managerTitle')}
      subtitle={t('plugin.noMarket')}
      size="lg"
      closeLabel={t('common.action.close')}
      dataHooks={{ 'data-plugin-manager': '1' }}
      footer={footer}
    >
      <div className="plugm">
        {/* 内存降级提示（02 §7.6 / E-STORE-01） */}
        {storageMode === 'memory' ? (
          <div className="plug-memory-banner" data-storage-mode="memory" role="status">
            <Download size={14} aria-hidden="true" />
            <span>{t('plugin.warn.memoryMode')}</span>
          </div>
        ) : null}

        {/* 安全模式提示（03 §5.3） */}
        {safeMode ? (
          <div className="plug-memory-banner" data-safe-mode="1" role="status">
            <ShieldAlert size={14} aria-hidden="true" />
            <span>
              <strong>{t('plugin.safe.title')}</strong> — {t('plugin.safe.body')}
            </span>
            <Button size="sm" variant="ghost" onClick={disableSafe}>
              {t('plugin.safe.exit')}
            </Button>
          </div>
        ) : null}

        {/* 安装入口 */}
        <div className="plugm__bar">
          <input
            ref={fileRef}
            type="file"
            accept=".lumenplug,application/json"
            hidden
            data-plugin-install-file="1"
            onChange={(event) => void onFileChange(event)}
          />
          <Button variant="outline" data-plugin-action="install-file" disabled={busy !== null} onClick={pickFile}>
            <FolderOpen size={13} /> {t('plugin.manager.installFromFile')}
          </Button>
          <Button variant="outline" data-plugin-action="install-url" disabled={busy !== null} onClick={openUrl}>
            <Link2 size={13} /> {t('plugin.manager.installFromUrl')}
          </Button>
          <Button variant="ghost" data-plugin-action="install-samples" disabled={busy !== null} onClick={installSamples}>
            {t('plugin.action.installSample')}
          </Button>
          <span className="plugm__bar-spacer" />
          <span className="plugm__hint">
            {t('plugin.manager.installed', { count: plugins.length })} ·{' '}
            {t('plugin.manager.enabledCount', { count: enabledCount })}
          </span>
        </div>

        {busy === 'prepare' || busy === 'samples' ? (
          <div className="plugm__hint" role="status" aria-live="polite">
            {busy === 'samples' ? t('plugin.install.installing') : t('plugin.install.reading')}
          </div>
        ) : null}

        {/* URL 安装：二次确认（03 §5.1 冻结文案） */}
        {urlOpen ? (
          <div className="plug-card" data-plugin-url-install="1">
            <div className="plug-card__body">
              <label className="plug-perm__label" htmlFor="plug-url-input">
                {t('plugin.install.urlLabel')}
              </label>
              <TextInput
                id="plug-url-input"
                value={urlValue}
                mono
                placeholder={t('plugin.install.urlPlaceholder')}
                data-plugin-url-input="1"
                onValueChange={(value) => {
                  setUrlValue(value)
                  setUrlConfirming(false)
                }}
              />
              {urlConfirming ? (
                <>
                  <p className="plug-error__body">{t('plugin.install.urlConfirmBody')}</p>
                  <div className="plug-actions">
                    <Button size="sm" variant="primary" data-plugin-url-confirm="1" onClick={() => void confirmUrl()}>
                      {t('plugin.install.urlConfirmContinue')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setUrlConfirming(false)}>
                      {t('common.action.cancel')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="plug-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={urlValue.trim() === ''}
                    onClick={() => setUrlConfirming(true)}
                  >
                    {t('plugin.install.urlConfirmContinue')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setUrlOpen(false)}>
                    {t('common.action.cancel')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 插件列表 / 加载中 / 空态 */}
        {!runtimeReady && plugins.length === 0 ? (
          <div className="plug-skeleton" role="status" aria-live="polite">
            <span>{t('plugin.runtime.loading')}</span>
          </div>
        ) : plugins.length === 0 ? (
          <div className="plugm__empty">
            <span className="plugm__empty-title">{t('plugin.manager.empty')}</span>
            <span>{t('plugin.manager.emptyHint')}</span>
          </div>
        ) : (
          <div className="plugm__list">
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                lang={lang}
                busy={busy === plugin.id}
                expanded={expanded.has(plugin.id)}
                onTogglePermissions={() => togglePermissions(plugin.id)}
                onEnable={() => void run(plugin.id, () => enablePlugin(plugin.id), 'plugin.state.enabled')}
                onDisable={() => void run(plugin.id, () => disablePlugin(plugin.id), 'plugin.state.disabled')}
                onRetry={() => void run(plugin.id, () => retryPlugin(plugin.id), 'plugin.state.enabled')}
                onUninstall={() => {
                  setKeepData(false)
                  setUninstallTarget(plugin)
                }}
                onGrant={(capability) => void run(plugin.id, () => grantCapability(plugin.id, capability))}
                onRevoke={(capability) => void run(plugin.id, () => revokeCapability(plugin.id, capability))}
                onViewLogs={() => {
                  setAuditFilter(plugin.id)
                  setAuditOpen(true)
                }}
              />
            ))}
          </div>
        )}

        {/* 审计日志（本地环形 200 条，02 §7.7） */}
        <div className="plugm__audit-head">
          <Button
            size="sm"
            variant="ghost"
            data-audit-toggle="1"
            onClick={() => {
              setAuditOpen((value) => !value)
              if (auditOpen) setAuditFilter(null)
            }}
          >
            {t('plugin.audit.title')}
          </Button>
          <span className="plugm__audit-count" data-audit-count={audit.length}>
            {t('plugin.audit.count', { count: audit.length })}
          </span>
          {auditFilter ? (
            <Button size="sm" variant="ghost" onClick={() => setAuditFilter(null)}>
              {t('plugin.manager.filterAll')}
            </Button>
          ) : null}
          <span className="plugm__hint">{t('plugin.audit.limit')}</span>
        </div>
        {auditOpen ? (
          <div className="plug-audit" role="log" aria-label={t('plugin.a11y.auditLog')}>
            {filteredAudit.length === 0 ? (
              <div className="plug-audit__empty">{t('plugin.audit.empty')}</div>
            ) : (
              filteredAudit.map((entry) => {
                const actionKey = auditActionLabel(entry.action)
                const pluginName = entry.pluginId ? byId.get(entry.pluginId)?.name[lang] : undefined
                return (
                  <div className="plug-audit__row" key={`${entry.seq}-${entry.at}`} data-audit-seq={entry.seq}>
                    <span className="plug-audit__at">{formatDate(entry.at, lang)}</span>
                    <span className="plug-audit__what">
                      {t(AUDIT_ACTOR_KEYS[entry.actor])} ·{' '}
                      {actionKey ? t(actionKey) : <code className="plug-audit__code">{entry.action}</code>}
                      {pluginName ? ` · ${pluginName}` : entry.pluginId ? ` · ${entry.pluginId}` : ''}
                      {entry.detail ? <span className="plug-audit__code"> · {entry.detail}</span> : null}
                    </span>
                    <span className={`plug-audit__result plug-audit__result--${entry.result}`}>
                      {t(AUDIT_RESULT_KEYS[entry.result])}
                    </span>
                    {entry.code ? <span className="plug-audit__code">{entry.code}</span> : null}
                  </div>
                )
              })
            )}
          </div>
        ) : null}
      </div>

      {/* 卸载确认（03 §5.1） */}
      <PluginModal
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        title={t('plugin.uninstall.title', { name: uninstallTarget?.name[lang] ?? '' })}
        size="sm"
        closeLabel={t('common.action.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUninstallTarget(null)}>
              {t('common.action.cancel')}
            </Button>
            <Button
              variant="danger"
              data-plugin-uninstall-confirm="1"
              disabled={busy !== null}
              onClick={() => uninstallTarget && doUninstall(uninstallTarget)}
            >
              {t('plugin.action.uninstall')}
            </Button>
          </>
        }
      >
        <div className="plug-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <p className="plug-error__body">{t('plugin.uninstall.body')}</p>
          <label className="plug-perm__label">
            <input type="checkbox" checked={keepData} onChange={(event) => setKeepData(event.target.checked)} />
            <span>{t('plugin.uninstall.keepData')}</span>
          </label>
        </div>
      </PluginModal>

      {/* 恢复默认工作台（03 §5.3：二次确认 + 输入 RESET，不可撤销；deck 不动） */}
      <PluginModal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t('plugin.reset.title')}
        size="sm"
        closeLabel={t('common.action.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t('common.action.cancel')}
            </Button>
            <Button
              variant="danger"
              data-plugin-reset-confirm="1"
              disabled={resetText.trim().toUpperCase() !== 'RESET' || busy !== null}
              onClick={doReset}
            >
              {t('plugin.action.reset')}
            </Button>
          </>
        }
      >
        <div className="plug-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <p className="plug-error__body">{t('plugin.reset.body')}</p>
          <label className="plug-perm__label" htmlFor="plug-reset-input">
            {t('plugin.reset.confirmLabel')}
          </label>
          <TextInput
            id="plug-reset-input"
            value={resetText}
            mono
            placeholder="RESET"
            data-plugin-reset-input="1"
            onValueChange={setResetText}
          />
          <span className="plugm__hint">{t('plugin.reset.confirmHint')}</span>
        </div>
      </PluginModal>

      {/* 打开安全模式（需重启生效） */}
      <PluginModal
        open={safeConfirmOpen}
        onClose={() => setSafeConfirmOpen(false)}
        title={t('plugin.safe.pill')}
        size="sm"
        closeLabel={t('common.action.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSafeConfirmOpen(false)}>
              {t('common.action.cancel')}
            </Button>
            <Button variant="danger" data-plugin-safe-confirm="1" onClick={enableSafe}>
              {t('plugin.safe.pill')}
            </Button>
          </>
        }
      >
        <p className="plug-error__body">{t('plugin.safe.body')}</p>
      </PluginModal>
    </PluginModal>
  )
}

/* ============================== 插件卡 ============================== */

interface PluginCardProps {
  plugin: PluginSummary
  lang: 'zh' | 'en'
  busy: boolean
  expanded: boolean
  onTogglePermissions: () => void
  onEnable: () => void
  onDisable: () => void
  onRetry: () => void
  onUninstall: () => void
  onGrant: (capability: Capability) => void
  onRevoke: (capability: Capability) => void
  onViewLogs: () => void
}

function PluginCard({
  plugin,
  lang,
  busy,
  expanded,
  onTogglePermissions,
  onEnable,
  onDisable,
  onRetry,
  onUninstall,
  onGrant,
  onRevoke,
  onViewLogs,
}: PluginCardProps) {
  const t = useT()
  const quarantined = plugin.state === 'quarantined'
  const stateKey = `plugin.state.${plugin.state}` as MessageKey
  const sourceKey =
    plugin.installSource === 'builtin'
      ? 'plugin.source.builtin'
      : plugin.installSource === 'url'
        ? 'plugin.source.url'
        : 'plugin.source.file'
  const lastErrorKey = plugin.lastError
    ? (pluginErrorKey(plugin.lastError.code as PluginErrorCode) as MessageKey)
    : null

  return (
    <article
      className={quarantined ? 'plug-card plug-card--quarantined' : 'plug-card'}
      data-plugin-id={plugin.id}
      data-plugin-state={plugin.state}
    >
      <div className="plug-card__head">
        <div className="plug-card__ident">
          <div className="plug-card__name">
            {plugin.name[lang]}
            <span className="plug-badge">{t(stateKey)}</span>
            <span className="plug-badge">{t(sourceKey)}</span>
            {plugin.trust === 'builtin' ? (
              <span className="plug-badge plug-badge--builtin">{t('plugin.source.builtin')}</span>
            ) : (
              <span className="plug-badge">{t('plugin.source.unsigned')}</span>
            )}
          </div>
          <div className="plug-card__meta">
            <span>{t('plugin.manager.version', { version: plugin.version })}</span>
            <span>{t('plugin.manager.author', { name: plugin.author.name })}</span>
            <span>{t('plugin.manager.license', { license: plugin.license })}</span>
            <span>{formatDate(plugin.installedAt, lang)}</span>
            {plugin.sourceUrl ? <span className="plug-muted">{plugin.sourceUrl}</span> : null}
          </div>
          <p className="plug-card__desc">{plugin.description[lang]}</p>
          {plugin.lastError && !quarantined ? (
            <p className="plug-error__reason">
              {lastErrorKey ? t(lastErrorKey) : plugin.lastError.code}
              {plugin.failureCount > 0 ? ` · ${t('plugin.errorCard.failureCount', { count: plugin.failureCount })}` : ''}
            </p>
          ) : null}
        </div>
      </div>

      {quarantined ? (
        <div className="plug-card__body">
          <PluginErrorCard
            titleKey="plugin.errorCard.quarantinedTitle"
            body={t('plugin.errorCard.quarantinedBody')}
            code={plugin.lastError?.code}
            failureCount={plugin.failureCount}
            onRetry={onRetry}
            onDisable={onDisable}
            onViewLogs={onViewLogs}
          />
        </div>
      ) : null}

      <div className="plug-card__body">
        <div className="plug-actions">
          <Button size="sm" variant="ghost" data-plugin-action="permissions" onClick={onTogglePermissions}>
            {t('plugin.manager.capabilities', { count: plugin.capabilities.length })}
          </Button>
          <span className="plug-muted">
            {plugin.enabled ? t('plugin.state.enabled') : t('plugin.state.disabled')}
          </span>
        </div>

        {expanded ? (
          <div className="plug-perm-card__list" data-plugin-permissions="1">
            {plugin.capabilities.length === 0 ? (
              <p className="plug-card__section-title">{t('plugin.permission.none')}</p>
            ) : null}
            {plugin.capabilities.map((capability) => {
              const meta = CAPABILITY_META[capability]
              const granted = plugin.grants.includes(capability) && !plugin.denied.includes(capability)
              const sensitive = isSensitiveCapability(capability)
              return (
                <div
                  key={capability}
                  className="plug-perm"
                  data-permission={capability}
                  data-granted={granted ? 'true' : 'false'}
                >
                  <div className="plug-perm__main">
                    <label className="plug-perm__label">
                      <input
                        type="checkbox"
                        checked={granted}
                        aria-label={t('plugin.permission.title')}
                        onChange={(event) => {
                          if (event.target.checked) onGrant(capability)
                          else onRevoke(capability)
                        }}
                      />
                      <span>{t(meta.labelKey as MessageKey)}</span>
                      {sensitive ? (
                        <span className="plug-badge plug-badge--sensitive">{t('plugin.permission.sensitiveBadge')}</span>
                      ) : null}
                    </label>
                    {sensitive && meta.detailKey ? (
                      <span className="plug-perm__detail">{t(meta.detailKey as MessageKey)}</span>
                    ) : null}
                  </div>
                  <div className="plug-perm__control">
                    <span className="plug-muted">
                      {granted ? t('plugin.permission.granted') : t('plugin.permission.denied')}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="plug-card__actions">
        {plugin.enabled ? (
          <Button size="sm" variant="outline" data-plugin-action="disable" disabled={busy} onClick={onDisable}>
            {t('plugin.action.disable')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" data-plugin-action="enable" disabled={busy} onClick={onEnable}>
            {t('plugin.action.enable')}
          </Button>
        )}
        {plugin.failureCount > 0 || quarantined ? (
          <Button size="sm" variant="ghost" data-plugin-action="retry" disabled={busy} onClick={onRetry}>
            {t('plugin.action.retry')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" data-plugin-action="audit" onClick={onViewLogs}>
          {t('plugin.action.viewLogs')}
        </Button>
        <span className="plug-card__actions-spacer" />
        <Button size="sm" variant="danger" data-plugin-action="uninstall" disabled={busy} onClick={onUninstall}>
          {t('plugin.action.uninstall')}
        </Button>
      </div>
    </article>
  )
}
