/**
 * src/portal/PortalApp.tsx —— 独立门户页（瀑布式长页）。
 *
 * 结构：Hero → 为什么 → 怎么用 → 实机截图（虚拟窗口）→ 能力瀑布 → 数字 → 开始 → 关于/许可。
 * 只依赖设置与 i18n，不加载编辑器 / 渲染器 / three；`portal.html` 与 `?portal=1` 共用。
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { Lang } from '@/i18n'
import { useT } from '@/i18n'
import { useSettingsStore, settingsSnapshot, type LlmProviderId } from '@/state/settingsStore'
import { saveSettings } from '@/persistence/decks'
import { applyPreset, PRESETS } from '@/ai/presets'
import { APP_VERSION } from '@/version'
import { GITHUB_URL, LICENSE_URL, PROJECT_URL, portalCopy } from './copy'
import './portal.css'

interface Shot {
  id: string
  label: string
  caption: string
  src: string
  alt: string
}

const SHOTS: Shot[] = [
  {
    id: 'forge',
    label: 'forge',
    caption: '',
    src: './portal/forge-cast.png',
    alt: 'LUMEN 造幕台：九张幕卡逐幕落位',
  },
  {
    id: 'editor',
    label: 'editor',
    caption: '',
    src: './portal/ui-editor.png',
    alt: 'LUMEN 画布编辑器：1600×900 画布',
  },
  {
    id: 'composer',
    label: 'composer',
    caption: '',
    src: './portal/ui-composer.png',
    alt: 'LUMEN 精确模式：右栏 AI 编排表单',
  },
  {
    id: 'studio',
    label: 'studio',
    caption: '',
    src: './portal/studio-3d.png',
    alt: 'LUMEN 工作室：3D 场景编辑',
  },
  {
    id: 'play',
    label: 'play',
    caption: '',
    src: './portal/ui-play.png',
    alt: 'LUMEN 播放器：全屏播放',
  },
]

export interface PortalAppProps {
  /** 灯箱/嵌入时覆盖入口地址；默认跳 `./index.html`。 */
  onEnter?: () => void
}

export function PortalApp({ onEnter }: PortalAppProps) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const setLang = useSettingsStore((s) => s.setLang)
  const reducedMotion = useSettingsStore((s) => s.reducedMotion)
  const setReducedMotion = useSettingsStore((s) => s.setReducedMotion)
  const llm = useSettingsStore((s) => s.llm)
  const patchLlm = useSettingsStore((s) => s.patchLlm)
  const forge = useSettingsStore((s) => s.forge)
  const patchForge = useSettingsStore((s) => s.patchForge)

  const copy = portalCopy(lang)
  const [drawer, setDrawer] = useState(false)
  const [shot, setShot] = useState(0)
  const [copied, setCopied] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState<number | null>(null)
  const [progress, setProgress] = useState(0)
  const [scrolled, setScrolled] = useState(false)
  const heroRef = useRef<HTMLDivElement>(null)
  const windowRef = useRef<HTMLDivElement>(null)

  const enter = async () => {
    if (onEnter) {
      onEnter()
      return
    }
    // 抽屉里的改动可能还在 400ms 节流窗口里；跳转前显式落盘一次。
    try {
      await saveSettings(settingsSnapshot(useSettingsStore.getState()))
    } catch {
      /* 存储不可用时照常进入 */
    }
    const replay = useSettingsStore.getState().llm.provider === 'replay'
    window.location.href = replay ? './index.html?strict=0' : './index.html'
  }

  /* 滚动进度 + 顶栏状态 */
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      setProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0)
      setScrolled(window.scrollY > 24)
      document.documentElement.style.setProperty('--portal-scroll', `${Math.min(window.scrollY, 1200)}`)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  /* 滚动进入：一次性的观察器 */
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-in'))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [lang])

  /* 键盘：Enter 进入、Esc 关抽屉 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawer) {
        setDrawer(false)
        return
      }
      if (event.key !== 'Enter' || drawer) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'BUTTON' || target?.tagName === 'INPUT' || target?.tagName === 'A') return
      event.preventDefault()
      void enter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const tilt = (event: ReactPointerEvent<HTMLElement>, target: HTMLElement | null, max: number) => {
    if (reducedMotion || !target) return
    const rect = target.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width - 0.5
    const y = (event.clientY - rect.top) / rect.height - 0.5
    target.style.setProperty('--ry', `${(x * max).toFixed(2)}deg`)
    target.style.setProperty('--rx', `${(-y * max).toFixed(2)}deg`)
  }

  const resetTilt = (target: HTMLElement | null) => {
    target?.style.setProperty('--ry', '0deg')
    target?.style.setProperty('--rx', '0deg')
  }

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(copy.about.email)
    } catch {
      /* 剪贴板不可用：仍然给视觉反馈 */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const copyCommand = async (cmd: string, index: number) => {
    try {
      await navigator.clipboard.writeText(cmd)
    } catch {
      /* ignore */
    }
    setCopiedCmd(index)
    window.setTimeout(() => setCopiedCmd(null), 1400)
  }

  const channel: LlmProviderId = llm.provider
  const channelOptions = [
    { id: 'mock' as const, label: t('portal.offline') },
    { id: 'replay' as const, label: t('portal.replay') },
    { id: 'openai' as const, label: t('portal.custom') },
  ]
  const modelPresets = PRESETS.filter((preset) => ['deepseek', 'openai', 'ollama'].includes(preset.id))

  return (
    <div className="portal" data-portal="1" data-lang={lang} data-reduced={reducedMotion ? '1' : '0'}>
      <div className="portal__progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      <header className={scrolled ? 'portal__header is-scrolled' : 'portal__header'}>
        <a className="portal__brand" href="#top" aria-label="LUMEN">
          <span className="portal__logo">
            LUMEN<span>.</span>
          </span>
          <span className="portal__brandzh">幕光</span>
        </a>
        <nav className="portal__nav" aria-label="Portal">
          <a href="#why">{copy.nav.philosophy}</a>
          <a href="#how">{copy.nav.steps}</a>
          <a href="#live">{copy.nav.shots}</a>
          <a href="#features">{copy.nav.features}</a>
          <a href="#about">{copy.nav.about}</a>
        </nav>
        <div className="portal__actions">
          <span className="portal__version">v{APP_VERSION}</span>
          <button type="button" className="portal__ghost" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <button type="button" className="portal__ghost" aria-haspopup="dialog" onClick={() => setDrawer(true)}>
            {copy.nav.preferences}
          </button>
          <a className="portal__ghost" href="./index.html?channel=replay&speed=0&strict=0">
            {copy.nav.replay}
          </a>
          <button
            type="button"
            className="portal__enter portal__enter--sm"
            data-act="enter"
            title={copy.nav.enterHint}
            onClick={() => void enter()}
          >
            {copy.nav.enter}
            <kbd>↵</kbd>
          </button>
        </div>
      </header>

      <main id="top">
        {/* ------------------------------- Hero ------------------------------- */}
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__glow" aria-hidden="true" />
          <div className="hero__grid">
            <div className="hero__copy">
              <span className="hero__eyebrow" data-reveal>
                {copy.hero.eyebrow}
              </span>
              <h1 id="hero-title" className="portal__claim" data-reveal style={{ '--d': '40ms' } as CSSProperties}>
                {copy.hero.titleA}
                <br />
                <em>{copy.hero.titleB}</em>
              </h1>
              <p className="hero__subtitle" data-reveal style={{ '--d': '70ms' } as CSSProperties}>
                {copy.hero.subtitle}
              </p>
              <p className="hero__lead" data-reveal style={{ '--d': '90ms' } as CSSProperties}>
                {copy.hero.lead}
              </p>
              <div className="hero__cta" data-reveal style={{ '--d': '140ms' } as CSSProperties}>
                <button type="button" className="portal__enter" data-act="enter" onClick={() => void enter()}>
                  {copy.hero.cta}
                  <kbd>{copy.hero.ctaHint}</kbd>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path
                      d="M3 8h9M8.6 4.2 12.4 8l-3.8 3.8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <a className="portal__textlink" href="./index.html?channel=replay&speed=0&strict=0">
                  {copy.hero.secondary} ↗
                </a>
              </div>
              <p className="hero__note" data-reveal style={{ '--d': '170ms' } as CSSProperties}>
                {copy.hero.note}
              </p>
              <dl className="hero__stats" data-reveal style={{ '--d': '190ms' } as CSSProperties}>
                {copy.hero.stats.map((item) => (
                  <div key={item.label}>
                    <dt>{item.value}</dt>
                    <dd>{item.label}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div
              className="hero__visual"
              ref={heroRef}
              data-reveal
              style={{ '--d': '120ms' } as CSSProperties}
              onPointerMove={(event) => tilt(event, heroRef.current, 8)}
              onPointerLeave={() => resetTilt(heroRef.current)}
              aria-hidden="true"
            >
              <div className="hero__stack">
                {copy.hero.cards.map((card, index) => (
                  <div key={card.label} className="hero__card" data-index={index}>
                    <img src={card.src} alt="" />
                    <span className="hero__card-shade" />
                    <span className="hero__card-tag">{card.label}</span>
                    <span className="hero__card-no">{String(index + 1).padStart(2, '0')}</span>
                  </div>
                ))}
                <span className="hero__floating" aria-hidden="true" />
              </div>
              <span className="hero__scroll">{copy.hero.scroll} ↓</span>
            </div>
          </div>
        </section>

        {/* ----------------------------- Philosophy ----------------------------- */}
        <section id="why" className="section philosophy" data-ghost="01" aria-labelledby="why-title">
          <div className="section__head" data-reveal>
            <span className="section__kicker">{copy.philosophy.kicker}</span>
            <h2 id="why-title" className="section__title">
              {copy.philosophy.title}
            </h2>
            <p className="section__lead">{copy.philosophy.lead}</p>
          </div>
          <div className="philosophy__grid">
            {copy.philosophy.items.map((item, index) => (
              <article
                key={item.title}
                className="philosophy__card"
                data-reveal
                style={{ '--d': `${index * 70}ms` } as CSSProperties}
              >
                <span className="philosophy__no">0{index + 1}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* -------------------------------- Steps -------------------------------- */}
        <section id="how" className="section steps" data-ghost="02" aria-labelledby="how-title">
          <div className="section__head" data-reveal>
            <span className="section__kicker">{copy.steps.kicker}</span>
            <h2 id="how-title" className="section__title">
              {copy.steps.title}
            </h2>
            <p className="section__lead">{copy.steps.lead}</p>
          </div>
          <div className="steps__list">
            {copy.steps.items.map((item, index) => (
              <div
                key={item.n}
                className="step"
                data-reveal
                style={{ '--d': `${index * 80}ms` } as CSSProperties}
              >
                <span className="step__n">{item.n}</span>
                <div className="step__body">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
                <span className="step__bar" aria-hidden="true" />
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------- Shots -------------------------------- */}
        <section id="live" className="section shots" data-ghost="03" aria-labelledby="live-title">
          <div className="section__head" data-reveal>
            <span className="section__kicker">{copy.shots.kicker}</span>
            <h2 id="live-title" className="section__title">
              {copy.shots.title}
            </h2>
            <p className="section__lead">{copy.shots.lead}</p>
          </div>

          <div
            className="shot"
            ref={windowRef}
            data-reveal
            onPointerMove={(event) => tilt(event, windowRef.current, 2.4)}
            onPointerLeave={() => resetTilt(windowRef.current)}
          >
            <div className="shot__chrome" aria-hidden="true">
              <span className="shot__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="shot__address">{copy.hero.window.address}</span>
              <span className="shot__tag">
                <i /> {copy.hero.window.tag}
              </span>
            </div>
            <div className="shot__tabs" role="tablist" aria-label={copy.shots.kicker}>
              {copy.shots.tabs.map((tab, index) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={shot === index}
                  data-on={shot === index ? '1' : '0'}
                  onClick={() => setShot(index)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="shot__view" role="tabpanel">
              <img key={SHOTS[shot].src} src={SHOTS[shot].src} alt={SHOTS[shot].alt} />
              <span className="shot__caption">{copy.shots.tabs[shot].caption}</span>
            </div>
            <div className="shot__strip" aria-hidden="true">
              {SHOTS.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  tabIndex={-1}
                  className={index === shot ? 'is-on' : ''}
                  onClick={() => setShot(index)}
                >
                  <img src={item.src} alt="" />
                </button>
              ))}
            </div>
          </div>
          <p className="shot__hint" data-reveal>
            {copy.shots.hint}
          </p>
        </section>

        {/* ------------------------------ Features ------------------------------ */}
        <section id="features" className="section features" data-ghost="04" aria-labelledby="features-title">
          <div className="section__head" data-reveal>
            <span className="section__kicker">{copy.features.kicker}</span>
            <h2 id="features-title" className="section__title">
              {copy.features.title}
            </h2>
            <p className="section__lead">{copy.features.lead}</p>
          </div>
          <div className="feature-grid">
            {copy.features.items.map((item, index) => (
              <article
                key={item.key}
                className={`feature feature--${item.key}`}
                data-reveal
                style={{ '--d': `${(index % 4) * 55}ms` } as CSSProperties}
              >
                <span className="feature__tag">{item.tag}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <span className="feature__no" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </article>
            ))}
          </div>

          <dl className="facts" data-reveal>
            {copy.facts.map((item) => (
              <div key={item.label}>
                <dt>{item.value}</dt>
                <dd>{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* -------------------------------- Start -------------------------------- */}
        <section id="start" className="section start" data-ghost="05" aria-labelledby="start-title">
          <div className="start__grid">
            <div className="start__prefs" data-reveal>
              <span className="section__kicker">{copy.start.kicker}</span>
              <h2 id="start-title" className="section__title">
                {copy.start.title}
              </h2>
              <p className="section__lead">{copy.start.lead}</p>
              <dl className="start__pref-list">
                {copy.start.preferences.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              <button type="button" className="portal__ghost start__settings" onClick={() => setDrawer(true)}>
                {copy.start.settingsCta}
              </button>
            </div>

            <div className="start__final" data-reveal style={{ '--d': '80ms' } as CSSProperties}>
              <p className="start__final-title">{copy.start.finalTitle}</p>
              <button type="button" className="portal__enter" data-act="enter" onClick={() => void enter()}>
                {copy.start.cta}
                <kbd>↵</kbd>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path
                    d="M3 8h9M8.6 4.2 12.4 8l-3.8 3.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <p className="start__note">{copy.start.finalNote}</p>

              <div className="start__code" data-reveal style={{ '--d': '120ms' } as CSSProperties}>
                <span className="start__code-label">{copy.start.commandsLabel}</span>
                {copy.start.commands.map((item, index) => (
                  <div key={item.cmd} className="start__line">
                    <code>{item.cmd}</code>
                    <span className="start__line-note">{item.note}</span>
                    <button
                      type="button"
                      className="start__copy"
                      aria-label={copiedCmd === index ? copy.about.copied : copy.about.copy}
                      onClick={() => void copyCommand(item.cmd, index)}
                    >
                      {copiedCmd === index ? '✓' : copy.about.copy}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------- About -------------------------------- */}
        <section id="about" className="section about" data-ghost="06" aria-labelledby="about-title">
          <div className="about__card" data-reveal>
            <div className="about__head">
              <span className="section__kicker">{copy.about.kicker}</span>
              <h2 id="about-title" className="section__title">
                {copy.about.title}
              </h2>
              {copy.about.lead ? <p className="section__lead">{copy.about.lead}</p> : null}
            </div>
            <div className="author">
              <a
                className="author__avatar"
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label={`GitHub · ${copy.about.author}`}
              >
                <img src="./portal/avatar.jpg" alt={`${copy.about.author} 的头像`} />
              </a>
              <div className="author__body">
                <h3>{copy.about.author}</h3>
                <span className="author__role">{copy.about.role}</span>
                <p>{copy.about.bio}</p>
              </div>
            </div>
            <div className="author__links">
              <div>
                <span>{copy.about.projectLabel}</span>
                <a href={PROJECT_URL} target="_blank" rel="noreferrer">
                  {copy.about.project} ↗
                </a>
              </div>
              <div>
                <span>{copy.about.emailLabel}</span>
                <a href={`mailto:${copy.about.email}`}>{copy.about.email}</a>
                <button type="button" onClick={() => void copyEmail()}>
                  {copied ? copy.about.copied : copy.about.copy}
                </button>
              </div>
              <div>
                <span>{copy.about.licenseLabel}</span>
                <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                  {copy.about.license}
                </a>
                <small>{copy.about.licenseNote}</small>
                <a className="author__license-link" href={LICENSE_URL} target="_blank" rel="noreferrer">
                  {copy.about.licenseLink} ↗
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="portal__footer">
        <span>{copy.footer.made}</span>
        <span className="portal__footer-links">
          <a href={PROJECT_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
            {copy.about.license}
          </a>
          <a href="#top">{copy.footer.top}</a>
        </span>
        <span>{copy.footer.rights}</span>
      </footer>

      {drawer ? (
        <div className="portal__drawer-mask" onClick={() => setDrawer(false)}>
          <aside
            className="portal__drawer"
            role="dialog"
            aria-modal="true"
            aria-label={copy.nav.preferences}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{copy.nav.preferences}</strong>
              <button type="button" className="portal__ghost" aria-label={t('portal.close')} onClick={() => setDrawer(false)}>
                ×
              </button>
            </header>

            <section>
              <label>{t('portal.channel')}</label>
              <div className="portal__seg">
                {channelOptions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-on={channel === item.id ? '1' : '0'}
                    onClick={() => {
                      if (item.id === 'mock') patchLlm({ provider: 'mock' })
                      else if (item.id === 'replay') patchLlm({ provider: 'replay' })
                      else patchLlm({ ...applyPreset(llm, llm.presetId ?? 'deepseek'), provider: 'openai' })
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <label>{t('portal.model')}</label>
              <div className="portal__seg">
                {modelPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    data-on={llm.presetId === preset.id ? '1' : '0'}
                    onClick={() => patchLlm(applyPreset(llm, preset.id))}
                  >
                    {t(preset.labelKey as 'ai.panel.preset.deepseek')}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <label>{t('portal.tier')}</label>
              <div className="portal__seg portal__seg--five">
                {(['auto', 'L3', 'L2', 'L1', 'L0'] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    data-on={forge.tier === tier ? '1' : '0'}
                    onClick={() => patchForge({ tier })}
                  >
                    {tier === 'auto'
                      ? t('forge.settings.tierAuto')
                      : t(`forge.assemble.tier.${tier.toLowerCase()}` as 'forge.assemble.tier.l3')}
                  </button>
                ))}
              </div>
            </section>

            <section className="portal__switch">
              <span>{t('portal.audio')}</span>
              <button
                type="button"
                className="portal__knob"
                data-on={forge.sound ? '1' : '0'}
                aria-pressed={forge.sound}
                onClick={() => patchForge({ sound: !forge.sound })}
              >
                <i />
              </button>
            </section>

            <section className="portal__switch">
              <span>{t('portal.reduce')}</span>
              <button
                type="button"
                className="portal__knob"
                data-on={reducedMotion ? '1' : '0'}
                aria-pressed={reducedMotion}
                onClick={() => setReducedMotion(!reducedMotion)}
              >
                <i />
              </button>
            </section>

            <section>
              <label>{t('portal.language')}</label>
              <div className="portal__seg">
                {(['zh', 'en'] as Lang[]).map((item) => (
                  <button key={item} type="button" data-on={lang === item ? '1' : '0'} onClick={() => setLang(item)}>
                    {t(`common.lang.${item}`)}
                  </button>
                ))}
              </div>
            </section>

            <a className="portal__drawer-license" href={LICENSE_URL} target="_blank" rel="noreferrer">
              {copy.about.license} · {copy.about.licenseNote}
            </a>          </aside>
        </div>
      ) : null}
    </div>
  )
}
