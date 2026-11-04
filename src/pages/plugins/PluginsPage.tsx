/**
 * src/pages/plugins/PluginsPage.tsx —— 插件页（05 §7 的六段结构，双语）。
 *
 * ①首屏 ②三款样例安装卡 ③权限摘要（含「它不能做什么」）④作者/许可
 * ⑤插件开发文档入口 ⑥「0.4.0 没有插件市场」声明；另有安装方法/安全/创造入口/FAQ/页脚。
 *
 * 测试钩子（06 §3.1）：`[data-sample-card]` `[data-install-sample]` `[data-permission][data-granted]`
 * `[data-devdocs]` `[data-no-market]`；整页 `html[data-lumen-plugins-page="1"]`（plugins.html 上）。
 *
 * 安装语义（Lead 2026-11-03 裁定 a）：点击「安装」时懒加载 `@/plugins/public` 的
 * `installBuiltinSample(sampleId)`；它不存在时回退为「下载 + 拖进工作台」，绝不在这页直写存储。
 */
import { useCallback, useState, type ReactElement } from 'react'
import { useT, type MessageKey } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import {
  CAPABILITY_I18N_KEY,
  DEV_DOC_PATH,
  DEV_DOC_URL,
  GITHUB_ISSUES_URL,
  GITHUB_URL,
  SAMPLE_CATALOG,
  isSensitiveCapability,
  sampleById,
  samplePackagePath,
  type SampleId,
} from './samples'

type InstallStatus = 'idle' | 'busy' | 'installed' | 'downloaded' | 'error'

interface InstallState {
  status: InstallStatus
  pluginId?: string
}

interface InstallOutcome {
  pluginId?: string
  state?: string
  enabled?: boolean
}

interface PluginsPublicModule {
  installBuiltinSample?: (sampleId: string) => Promise<InstallOutcome>
}

const EMPTY_INSTALL_STATE: Record<SampleId, InstallState> = {
  brandguard: { status: 'idle' },
  chartkit: { status: 'idle' },
  focusdesk: { status: 'idle' },
}

function key(value: string): MessageKey {
  return value as MessageKey
}

function triggerDownload(id: SampleId): void {
  const sample = sampleById(id)
  const anchor = document.createElement('a')
  anchor.href = samplePackagePath(id)
  anchor.download = `${id}-${sample.version}.lumenplug`
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function CapabilityChips({ capabilities }: { capabilities: string[] }): ReactElement {
  const t = useT()
  return (
    <ul className="pl-capabilities" role="list">
      {capabilities.map((capability) => {
        const label = CAPABILITY_I18N_KEY[capability]
          ? t(key(`plugin.capability.${CAPABILITY_I18N_KEY[capability]}`))
          : capability
        const sensitive = isSensitiveCapability(capability)
        return (
          <li
            key={capability}
            className="pl-capability"
            data-permission={capability}
            data-granted="false"
            data-sensitive={sensitive ? '1' : '0'}
          >
            <code className="pl-capability__id">{capability}</code>
            <span className="pl-capability__text">{label}</span>
            {sensitive ? <span className="pl-badge pl-badge--warn">{t(key('plugin.permission.sensitiveBadge'))}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function PluginsPage(): ReactElement {
  const t = useT()
  const lang = useSettingsStore((state) => state.lang)
  const setLang = useSettingsStore((state) => state.setLang)
  const [install, setInstall] = useState<Record<SampleId, InstallState>>(EMPTY_INSTALL_STATE)

  const patchInstall = useCallback((id: SampleId, next: InstallState) => {
    setInstall((prev) => ({ ...prev, [id]: next }))
  }, [])

  const installSample = useCallback(
    async (id: SampleId) => {
      patchInstall(id, { status: 'busy' })
      try {
        const mod = (await import('@/plugins/public')) as unknown as PluginsPublicModule
        if (typeof mod.installBuiltinSample !== 'function') {
          triggerDownload(id)
          patchInstall(id, { status: 'downloaded' })
          return
        }
        const outcome = await mod.installBuiltinSample(id)
        patchInstall(id, { status: 'installed', pluginId: outcome && outcome.pluginId })
      } catch {
        patchInstall(id, { status: 'error' })
      }
    },
    [patchInstall],
  )

  const downloadSample = useCallback(
    (id: SampleId) => {
      triggerDownload(id)
      patchInstall(id, { status: 'downloaded' })
    },
    [patchInstall],
  )

  const toggleLang = useCallback(() => {
    setLang(lang === 'zh' ? 'en' : 'zh')
  }, [lang, setLang])

  const statusText = (state: InstallState): string => {
    if (state.status === 'busy') return t(key('plugin.install.installing'))
    if (state.status === 'installed') return t(key('plugin.install.successDisabled'))
    if (state.status === 'downloaded') return t(key('pluginspage.samples.downloadDone'))
    if (state.status === 'error') return t(key('plugin.error.runtime'))
    return ''
  }

  return (
    <div className="pl-page" data-plugins-page="1" data-lang={lang}>
      <a className="pl-skip" href="#samples">
        {t(key('pluginspage.samples.title'))}
      </a>

      <header className="pl-topbar">
        <a className="pl-topbar__brand" href="./index.html">
          <span className="pl-topbar__mark" aria-hidden="true" />
          LUMEN
        </a>
        <nav className="pl-topbar__nav" aria-label={t(key('pluginspage.a11y.nav'))}>
          <a href="#samples">{t(key('pluginspage.samples.title'))}</a>
          <a href="#permissions">{t(key('pluginspage.permissions.title'))}</a>
          <a href="#install">{t(key('pluginspage.install.title'))}</a>
          <a href="#docs">{t(key('pluginspage.docs.title'))}</a>
          <a href="#faq">{t(key('pluginspage.faq.title'))}</a>
        </nav>
        <div className="pl-topbar__actions">
          <button type="button" className="pl-ghost" onClick={toggleLang} aria-label="Language">
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <a className="pl-primary pl-primary--small" href="./index.html">
            {t(key('pluginspage.back'))}
          </a>
        </div>
      </header>

      <main className="pl-main">
        {/* ① 首屏 */}
        <section className="pl-hero" aria-labelledby="pl-title">
          <p className="pl-eyebrow">{t(key('pluginspage.subtitle'))}</p>
          <h1 id="pl-title" className="pl-title">
            {t(key('pluginspage.title'))}
          </h1>
          <p className="pl-tagline">{t(key('pluginspage.tagline'))}</p>
          <div className="pl-hero__actions">
            <a className="pl-primary" href="#samples">
              {t(key('pluginspage.samples.title'))}
            </a>
            <a className="pl-secondary" href="#docs">
              {t(key('pluginspage.docs.title'))}
            </a>
          </div>
          <div className="pl-hero__stats">
            {SAMPLE_CATALOG.map((sample) => (
              <a key={sample.id} className="pl-stat" href={`#card-${sample.id}`}>
                <strong>{t(key(`pluginspage.sample.${sample.id}.name`))}</strong>
                <span>{t(key('pluginspage.samples.permissionsCount'), { count: sample.capabilities.length })}</span>
              </a>
            ))}
          </div>
          <aside className="pl-nomarket" data-no-market="1" role="note">
            <p>{t(key('pluginspage.noMarket'))}</p>
          </aside>
        </section>

        {/* ② 三款样例安装卡 */}
        <section className="pl-section" id="samples" aria-labelledby="pl-samples-title">
          <header className="pl-section__head">
            <h2 id="pl-samples-title">{t(key('pluginspage.samples.title'))}</h2>
            <p>{t(key('pluginspage.samples.body'))}</p>
          </header>
          <div className="pl-cards">
            {SAMPLE_CATALOG.map((sample) => {
              const state = install[sample.id]
              const name = t(key(`pluginspage.sample.${sample.id}.name`))
              const desc = t(key(`pluginspage.sample.${sample.id}.desc`))
              const status = statusText(state)
              return (
                <article
                  key={sample.id}
                  id={`card-${sample.id}`}
                  className="pl-card"
                  data-sample-card={sample.id}
                  data-sample-id={sample.id}
                  data-plugin-id={sample.pluginId}
                  data-install-state={state.status}
                  aria-label={t(key('pluginspage.samples.cardAria'), { name })}
                >
                  <header className="pl-card__head">
                    <div>
                      <h3>{name}</h3>
                      <code className="pl-card__id">{sample.pluginId}</code>
                    </div>
                    <span className="pl-badge" data-default-off="1">
                      {t(key('pluginspage.samples.defaultOff'))}
                    </span>
                  </header>
                  <p className="pl-card__desc">{desc}</p>
                  <dl className="pl-card__facts">
                    <div>
                      <dt>{t(key('pluginspage.samples.version'), { version: sample.version })}</dt>
                      <dd>{t(key('pluginspage.samples.size'), { size: `${sample.sizeKb} KB` })}</dd>
                    </div>
                    <div>
                      <dt>{t(key('pluginspage.samples.permissions'))}</dt>
                      <dd>{t(key('pluginspage.samples.permissionsCount'), { count: sample.capabilities.length })}</dd>
                    </div>
                  </dl>
                  <CapabilityChips capabilities={sample.capabilities} />
                  <p className="pl-card__hint">{t(key('pluginspage.samples.defaultOffHint'))}</p>
                  <div className="pl-card__actions">
                    <button
                      type="button"
                      className="pl-primary"
                      data-install-sample={sample.id}
                      data-plugin-id={sample.pluginId}
                      onClick={() => void installSample(sample.id)}
                      disabled={state.status === 'busy'}
                    >
                      {t(key('pluginspage.samples.install'))}
                    </button>
                    <button
                      type="button"
                      className="pl-ghost"
                      data-download-sample={sample.id}
                      onClick={() => downloadSample(sample.id)}
                    >
                      {t(key('pluginspage.samples.download'))}
                    </button>
                    <a className="pl-ghost pl-ghost--link" href={samplePackagePath(sample.id)} download>
                      .lumenplug
                    </a>
                  </div>
                  <p className="pl-card__status" role="status" aria-live="polite">
                    {status}
                  </p>
                  {state.status === 'installed' ? (
                    <a className="pl-inline-link" href="./index.html">
                      {t(key('pluginspage.install.open'))} →
                    </a>
                  ) : null}
                </article>
              )
            })}
          </div>
        </section>

        {/* ③ 权限摘要 */}
        <section className="pl-section" id="permissions" aria-labelledby="pl-perms-title">
          <header className="pl-section__head">
            <h2 id="pl-perms-title">{t(key('pluginspage.permissions.title'))}</h2>
            <p>{t(key('pluginspage.permissions.body'))}</p>
          </header>
          <div className="pl-perms">
            <div className="pl-panel">
              <h3>{t(key('pluginspage.permissions.cannotTitle'))}</h3>
              <ul className="pl-checks">
                <li>{t(key('pluginspage.permissions.cannot1'))}</li>
                <li>{t(key('pluginspage.permissions.cannot2'))}</li>
                <li>{t(key('pluginspage.permissions.cannot3'))}</li>
                <li>{t(key('pluginspage.permissions.cannot4'))}</li>
              </ul>
              <p className="pl-muted">{t(key('pluginspage.permissions.revoke'))}</p>
            </div>
            <div className="pl-panel">
              <h3>{t(key('pluginspage.permissions.sensitive'))}</h3>
              <ul className="pl-checks" data-sensitive-list="1">
                {SAMPLE_CATALOG.flatMap((sample) =>
                  sample.capabilities
                    .filter((capability) => isSensitiveCapability(capability))
                    .map((capability) => (
                      <li key={`${sample.id}-${capability}`} data-permission={capability} data-granted="false">
                        <code>{capability}</code>
                        <span>
                          {' '}
                          · {t(key(`pluginspage.sample.${sample.id}.name`))} ·{' '}
                          {CAPABILITY_I18N_KEY[capability]
                            ? t(key(`plugin.capability.${CAPABILITY_I18N_KEY[capability]}`))
                            : capability}
                        </span>
                      </li>
                    )),
                )}
              </ul>
            </div>
          </div>
        </section>

        {/* ④ 安装方法 */}
        <section className="pl-section" id="install" aria-labelledby="pl-install-title">
          <header className="pl-section__head">
            <h2 id="pl-install-title">{t(key('pluginspage.install.title'))}</h2>
            <p>{t(key('pluginspage.install.file'))}</p>
          </header>
          <ol className="pl-steps">
            <li>{t(key('pluginspage.install.step1'))}</li>
            <li>{t(key('pluginspage.install.step2'))}</li>
            <li>{t(key('pluginspage.install.step3'))}</li>
          </ol>
          <div className="pl-panel pl-panel--inline">
            <p>{t(key('pluginspage.install.url'))}</p>
            <p>{t(key('pluginspage.install.sample'))}</p>
            <p className="pl-muted">{t(key('pluginspage.install.dragHint'))}</p>
            <a className="pl-primary pl-primary--small" href="./index.html">
              {t(key('pluginspage.install.open'))}
            </a>
          </div>
        </section>

        {/* ⑤ 开发文档入口 + 作者/许可 */}
        <section className="pl-section" id="docs" aria-labelledby="pl-docs-title" data-devdocs="1">
          <header className="pl-section__head">
            <h2 id="pl-docs-title">{t(key('pluginspage.docs.title'))}</h2>
            <p>{t(key('pluginspage.docs.body'))}</p>
          </header>
          <div className="pl-grid">
            <div className="pl-panel">
              <h3>{t(key('pluginspage.docs.manifest'))}</h3>
              <ul className="pl-checks">
                <li>{t(key('pluginspage.docs.capabilities'))}</li>
                <li>{t(key('pluginspage.docs.slots'))}</li>
                <li>{t(key('pluginspage.docs.sdk'))}</li>
                <li>{t(key('pluginspage.docs.abi'))}</li>
                <li>{t(key('pluginspage.docs.samples'))}</li>
              </ul>
              <p className="pl-muted">{DEV_DOC_PATH}</p>
              <div className="pl-links">
                <a className="pl-secondary" href={DEV_DOC_URL} target="_blank" rel="noreferrer noopener">
                  {t(key('pluginspage.docs.open'))}
                </a>
                <a className="pl-ghost" href={`${GITHUB_URL}/tree/main/plugins/builtin`} target="_blank" rel="noreferrer noopener">
                  plugins/builtin
                </a>
              </div>
            </div>
            <div className="pl-panel">
              <h3>{t(key('pluginspage.author.title'))}</h3>
              <p>{t(key('pluginspage.author.body'))}</p>
              <dl className="pl-defs">
                <div>
                  <dt>{t(key('pluginspage.author.source'))}</dt>
                  <dd>
                    <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
                      {GITHUB_URL}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>{t(key('pluginspage.author.issues'))}</dt>
                  <dd>
                    <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer noopener">
                      {GITHUB_ISSUES_URL}
                    </a>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        {/* 安全 / 创造入口 / FAQ */}
        <section className="pl-section" id="safety" aria-labelledby="pl-safety-title">
          <header className="pl-section__head">
            <h2 id="pl-safety-title">{t(key('pluginspage.safety.title'))}</h2>
            <p>{t(key('pluginspage.safety.body'))}</p>
          </header>
          <ul className="pl-checks">
            <li>{t(key('pluginspage.safety.safeMode'))}</li>
            <li>{t(key('pluginspage.safety.data'))}</li>
            <li>{t(key('pluginspage.safety.diagnostics'))}</li>
            <li>{t(key('pluginspage.safety.reset'))}</li>
          </ul>
          <div className="pl-cta" aria-label={t(key('pluginspage.a11y.creator'))}>
            <div>
              <h3>{t(key('pluginspage.creator.title'))}</h3>
              <p>{t(key('pluginspage.creator.body'))}</p>
              <p className="pl-muted">{t(key('pluginspage.creator.noModel'))}</p>
            </div>
            <a className="pl-primary" href="./index.html?creator=1">
              {t(key('pluginspage.creator.open'))}
            </a>
          </div>
        </section>

        <section className="pl-section" id="faq" aria-labelledby="pl-faq-title">
          <header className="pl-section__head">
            <h2 id="pl-faq-title">{t(key('pluginspage.faq.title'))}</h2>
          </header>
          <div className="pl-faq">
            {[1, 2, 3, 4].map((index) => (
              <details key={index} className="pl-faq__item">
                <summary>{t(key(`pluginspage.faq.q${index}`))}</summary>
                <p>{t(key(`pluginspage.faq.a${index}`))}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="pl-footer">
        <p>{t(key('pluginspage.footer.note'))}</p>
        <p className="pl-muted">
          {t(key('pluginspage.footer.license'))} · {t(key('pluginspage.version'), { version: '0.4.0' })}
        </p>
      </footer>
    </div>
  )
}
