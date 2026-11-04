/**
 * PluginsTab.tsx —— 右栏「插件」页签内容（shell-ui 域）。
 *
 * 两个用途：
 * 1. `workspace.inspector.tab` 动态页签的**降级内容**：插件被停用/隔离后贡献消失，
 *    页签仍在（用户没切走）时给状态说明 + 一个回到管理的入口，不留白屏（D-40-18）。
 * 2. 插件状态速览：启用数、可用插件页签、打开管理弹窗。
 *
 * 不占内置 6 页签的位置（02 §6.8 禁止插件布局预设指向 `plug:*`）；
 * 它只在 `inspectorTab` 已是 `plug:*` 时被渲染。
 */
import { Plug } from 'lucide-react'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore, type InspectorTab } from '@/state/uiStore'
import { Button } from '@/ui/primitives'
import { useInspectorTabs, useInstalledPlugins, usePluginsEnabled } from '@/plugins/public'
import { openPluginManager } from '@/ui/dialogs/pluginUiStore'

export function PluginsTab({ contributionId }: { contributionId?: string }) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const tabs = useInspectorTabs()
  const plugins = useInstalledPlugins()
  const anyEnabled = usePluginsEnabled()
  const setInspectorTab = useUiStore((s) => s.setInspectorTab)
  const setRightMode = useUiStore((s) => s.setRightMode)

  const enabledPlugins = plugins.filter((plugin) => plugin.enabled)
  const current = contributionId
    ? tabs.find((tab) => tab.id === `plug:${contributionId}` || tab.id === contributionId)
    : undefined
  const nameOf = (pluginId: string): string => {
    const plugin = plugins.find((item) => item.id === pluginId)
    return plugin ? plugin.name[lang] : t('plugin.state.disabled')
  }

  const openManager = () => openPluginManager()

  return (
    <div className="plug-tab" data-plugin-tab="1" aria-label={t('plugin.title')}>
      <div className="plug-tab__title">
        {current ? current.title : t('plugin.title')}
      </div>

      {current ? null : (
        <p className="plug-tab__hint">
          {anyEnabled ? t('plugin.runtime.disabledHint') : t('plugin.manager.empty')}
        </p>
      )}

      <div className="plug-tab__hint">
        {t('plugin.manager.installed', { count: plugins.length })} ·{' '}
        {t('plugin.manager.enabledCount', { count: enabledPlugins.length })}
      </div>

      {tabs.length > 0 ? (
        <div className="plug-card__section-title">{t('plugin.slot.inspectorTab')}</div>
      ) : null}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="plug-tab__row"
          data-plugin-tab-entry={tab.id}
          aria-current={current?.id === tab.id ? 'page' : undefined}
          onClick={() => {
            setRightMode('inspector')
            setInspectorTab(tab.id as InspectorTab)
          }}
        >
          <Plug size={12} aria-hidden="true" />
          <span className="plug-tab__row-name">{tab.titleOf(lang) || tab.title}</span>
          <span className="plug-badge">{nameOf(tab.pluginId)}</span>
        </button>
      ))}

      <div className="plug-actions">
        <Button size="sm" variant="outline" data-plugin-tab-manager="1" onClick={openManager}>
          {t('plugin.managerTitle')}
        </Button>
      </div>
    </div>
  )
}
