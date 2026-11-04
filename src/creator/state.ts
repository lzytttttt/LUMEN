/**
 * creator/state.ts —— 创造模式的唯一状态机（04 §3，CR-40-01…04）。
 *
 * 三条硬规则（对应规格的三列）：
 * 1. 九态内部、七值对外：`saved/reverted` 在钩子上映射为 `applied` + `data-creator-outcome`；
 * 2. 事件 → 动作 → 副作用：reducer 是纯函数，副作用以 `CreatorEffect[]` 返回给 store 执行；
 * 3. 每次转移都可测试：不读时钟、不读设置、不碰 IDB / DOM / 网络。
 *
 * 不可变更新：所有分支返回新对象（测试可安全对比旧引用）。
 */
import type {
  Capability,
  CreatorProposal,
  PluginDraftStatus,
  PluginErrorCode,
} from '@/plugins/types'
import { SENSITIVE_CAPABILITIES } from '@/plugins/types'

/* ============================ 九态 / 七值 ============================ */

export const CREATOR_STATUSES = [
  'idle',
  'reading',
  'proposing',
  'proposal-ready',
  'trialing',
  'applied',
  'saved',
  'reverted',
  'failed',
] as const

export type CreatorStatus = (typeof CREATOR_STATUSES)[number]

/**
 * 对外只暴露 7 值（06 §3.1 冻结）：
 * `saved/reverted` → `applied` + `data-creator-outcome`。
 */
export const CREATOR_PUBLIC_STATES = [
  'idle',
  'reading',
  'proposing',
  'proposal-ready',
  'trialing',
  'applied',
  'failed',
] as const

export type CreatorPublicState = (typeof CREATOR_PUBLIC_STATES)[number]
export type CreatorOutcome = 'saved' | 'reverted'

/** 04 §3.4 映射表（CR-40-02 必须钉住）。 */
export const PUBLIC_STATE_BY_STATUS: Record<CreatorStatus, CreatorPublicState> = {
  idle: 'idle',
  reading: 'reading',
  proposing: 'proposing',
  'proposal-ready': 'proposal-ready',
  trialing: 'trialing',
  applied: 'applied',
  saved: 'applied',
  reverted: 'applied',
  failed: 'failed',
}

/** `data-creator-outcome` 取值（仅终态）。 */
export function outcomeOf(status: CreatorStatus): CreatorOutcome | undefined {
  if (status === 'saved') return 'saved'
  if (status === 'reverted') return 'reverted'
  return undefined
}

/** 试跑是否处于活动状态（`close/revert` 分支的依据）。 */
export function isTrialActive(status: CreatorStatus): boolean {
  return status === 'trialing' || status === 'applied'
}

/* ============================ 错误 ============================ */

/** UI 词条（04 §9.2 `creator.error.*`）——与错误码分开，码给诊断，键给界面。 */
export const CREATOR_ERROR_KEYS = [
  'badJson',
  'schema',
  'capMismatch',
  'sandbox',
  'code',
  'tooLarge',
  'timeout',
  'cancelled',
  'notConfigured',
  'host',
  'store',
  'nextStep',
] as const

export type CreatorErrorKey = (typeof CREATOR_ERROR_KEYS)[number]

export interface CreatorError {
  /** 02 §5.5 冻结错误码（`data-creator-error` 用它）。 */
  code: PluginErrorCode
  /** 界面文案键（`creator.error.<key>`）。 */
  uiKey: CreatorErrorKey
  /** 折叠详情（已脱敏；≤300 字符，04 §7.4）。 */
  detail?: string
}

/** 提案校验错误码（04 §4.3）→ 默认的界面键。 */
export function errorKeyOfCode(code: PluginErrorCode): CreatorErrorKey {
  switch (code) {
    case 'E-MAN-14':
      return 'tooLarge'
    case 'E-MAN-09':
    case 'E-MAN-13':
      return 'capMismatch'
    case 'E-RUN-01':
      return 'code'
    case 'E-RUN-02':
    case 'E-HOST-02':
    case 'E-HOST-03':
      return 'sandbox'
    case 'E-STORE-02':
      return 'store'
    case 'E-PKG-01':
      return 'badJson'
    default:
      return 'host'
  }
}

export function creatorError(code: PluginErrorCode, detail?: string): CreatorError {
  return { code, detail: sanitizeDetail(detail), uiKey: errorKeyOfCode(code) }
}

/** 错误详情脱敏 + 截断（04 §7.4：≤300；不含 API key / bearer / query）。 */
export function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  const redacted = detail
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/api[_-]?key["'\s:=]+[A-Za-z0-9._-]{8,}/gi, 'apiKey=***')
    .replace(/([?&](?:key|token|secret|api_key)=)[^&\s]+/gi, '$1***')
  return redacted.slice(0, 300)
}

/* ============================ 模板 ============================ */

export const CREATOR_TEMPLATE_IDS = ['theme', 'widget', 'command'] as const
export type CreatorTemplateId = (typeof CREATOR_TEMPLATE_IDS)[number]

export function isCreatorTemplateId(value: unknown): value is CreatorTemplateId {
  return typeof value === 'string' && (CREATOR_TEMPLATE_IDS as readonly string[]).includes(value)
}

/* ============================ 机器状态 ============================ */

export const MAX_CREATOR_HISTORY = 10
export const CREATOR_PROMPT_MAX = 400

/** 流式上屏只保留 `title/summary` 两个顶层字段（04 §3.2）。 */
export interface CreatorStream {
  title: string
  summary: string
  /** 本地估算的 token（`ceil(cjk*0.75 + latin/4)`，04 §6.4）。 */
  tokens: number
}

export interface CreatorHistoryEntry {
  revision: number
  proposal: CreatorProposal
  createdAt: number
}

/** 机器视角的试跑记录（快照实体在 `trial.ts` / `PluginTrial` 里）。 */
export interface CreatorTrialState {
  revision: number
  startedAt: number
  deckWrites: number
  /** 本次试跑实际授予的能力（非敏感默认允许；`deck:write` 显式开关）。 */
  granted: Capability[]
}

export interface CreatorMachine {
  status: CreatorStatus
  /** 用户原话（≤400；关闭面板不清）。 */
  prompt: string
  draftId: string | null
  revision: number
  proposal: CreatorProposal | null
  /** 按时间升序，最多 10 版（04 §5.4）。 */
  history: CreatorHistoryEntry[]
  error: CreatorError | null
  stream: CreatorStream | null
  trial: CreatorTrialState | null
  grantedCapabilities: Capability[]
  deckWrites: number
  restored: boolean
  interrupted: boolean
  template: CreatorTemplateId | null
  /** 面板打开来源（`data-creator-entry`）。 */
  entry: CreatorEntrySource | null
}

export type CreatorEntrySource = 'topbar' | 'palette' | 'shortcut' | 'url' | 'plugin-page'

export function initialCreatorMachine(): CreatorMachine {
  return {
    status: 'idle',
    prompt: '',
    draftId: null,
    revision: 0,
    proposal: null,
    history: [],
    error: null,
    stream: null,
    trial: null,
    grantedCapabilities: [],
    deckWrites: 0,
    restored: false,
    interrupted: false,
    template: null,
    entry: null,
  }
}

/* ============================ 事件 ============================ */

/** 非敏感能力（试跑默认允许，04 §7.1）。 */
export function trialGrantsOf(capabilities: Capability[]): Capability[] {
  return capabilities.filter((capability) => !(SENSITIVE_CAPABILITIES as readonly string[]).includes(capability))
}

export interface CreatorBootRecord {
  status: PluginDraftStatus
  draftId: string
  revision: number
  proposal: CreatorProposal
  history: CreatorHistoryEntry[]
  error?: CreatorError | null
  template?: CreatorTemplateId | null
  trial?: CreatorTrialState | null
  deckWrites?: number
}

export type CreatorEvent =
  | { type: 'panel.open'; entry?: CreatorEntrySource }
  | { type: 'panel.close' }
  | { type: 'prompt.submit'; prompt: string; draftId?: string }
  | { type: 'snapshot.ok' }
  | { type: 'snapshot.fail'; error?: CreatorError }
  | { type: 'stream.delta'; title?: string; summary?: string; tokens?: number }
  | { type: 'stream.done'; text: string }
  | { type: 'proposal.valid'; proposal: CreatorProposal; revision: number; draftId?: string; createdAt?: number }
  | { type: 'proposal.invalid'; error: CreatorError }
  | {
      type: 'template.start'
      templateId: CreatorTemplateId
      proposal: CreatorProposal
      revision: number
      draftId?: string
      createdAt?: number
    }
  | { type: 'history.pick'; revision: number }
  | { type: 'trial.start'; startedAt?: number; grants?: Capability[] }
  | { type: 'trial.deckwrite'; deckWrites?: number }
  | { type: 'trial.crash'; error?: CreatorError }
  | { type: 'keep' }
  | { type: 'keep.ok' }
  | { type: 'keep.fail'; error?: CreatorError }
  | { type: 'revert' }
  | { type: 'draft.discard' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'grant.deckWrite'; granted: boolean }
  | { type: 'resume.boot'; record: CreatorBootRecord }

/* ============================ 副作用 ============================ */

export const CREATOR_EFFECTS = [
  'new-draft',
  'persist-draft',
  'persist-history',
  'emit-state',
  'audit-propose',
  'audit-trial',
  'audit-keep',
  'audit-revert',
  'audit-export',
  'trial.start',
  'trial.stop',
  'trial.revert',
  'install.request',
  'validate.request',
  'propose.request',
  'cancel.request',
  'drop.draft',
] as const

export type CreatorEffect = (typeof CREATOR_EFFECTS)[number]

export interface CreatorTransition {
  machine: CreatorMachine
  effects: CreatorEffect[]
}

/* ============================ 工具 ============================ */

function patch(machine: CreatorMachine, next: Partial<CreatorMachine>, effects: CreatorEffect[]): CreatorTransition {
  return { machine: { ...machine, ...next }, effects }
}

function noop(machine: CreatorMachine): CreatorTransition {
  return { machine, effects: [] }
}

/** 追加/替换历史版（同 revision 覆盖；超出 10 版丢最旧，04 §5.4）。 */
export function pushHistory(
  history: CreatorHistoryEntry[],
  entry: CreatorHistoryEntry,
): CreatorHistoryEntry[] {
  const withoutSame = history.filter((item) => item.revision !== entry.revision)
  return [...withoutSame, entry]
    .sort((a, b) => a.revision - b.revision)
    .slice(-MAX_CREATOR_HISTORY)
}

/** 带「有新提案」的场景必须清掉旧错误与流。 */
const PROPOSAL_BASELINE = {
  error: null,
  stream: null,
  interrupted: false,
} as const

/* ============================ reducer ============================ */

/**
 * 唯一 reducer（04 §3.3 事件-动作表的逐行实现）。
 * 守卫不通过时返回原对象 + 空副作用（幂等，UI 重复派发安全）。
 */
export function creatorReducer(machine: CreatorMachine, event: CreatorEvent): CreatorTransition {
  switch (event.type) {
    case 'panel.open': {
      if (machine.entry === (event.entry ?? null)) return noop(machine)
      return patch(machine, { entry: event.entry ?? machine.entry ?? null }, ['emit-state'])
    }

    case 'panel.close': {
      // 有试跑：先停用（副作用由 store 调 trial.stop），面板收起但草稿记录保留（04 §3.3 close）。
      if (isTrialActive(machine.status)) {
        return patch(
          machine,
          {
            status: 'proposal-ready',
            trial: null,
            grantedCapabilities: [],
          },
          ['trial.stop', 'emit-state'],
        )
      }
      // 读/生成中取消：有旧提案回 proposal-ready，否则 idle。
      if (machine.status === 'reading' || machine.status === 'proposing') {
        return patch(
          machine,
          {
            status: machine.proposal ? 'proposal-ready' : 'idle',
            stream: null,
            trial: null,
            grantedCapabilities: [],
          },
          ['cancel.request', 'emit-state'],
        )
      }
      if (machine.status === 'proposal-ready') return noop(machine)
      return noop(machine)
    }

    case 'prompt.submit': {
      const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
      if (prompt === '' || prompt.length > CREATOR_PROMPT_MAX) return noop(machine)
      // 无活动草稿时由 store 生成 draftId（`new-draft` 副作用）；有草稿则同一 draft 内 revision++。
      return patch(
        machine,
        {
          status: 'reading',
          prompt,
          draftId: event.draftId ?? machine.draftId,
          error: null,
          stream: null,
          trial: null,
          grantedCapabilities: [],
          interrupted: false,
          template: null,
        },
        ['new-draft', 'propose.request', 'emit-state'],
      )
    }

    case 'snapshot.ok': {
      if (machine.status !== 'reading') return noop(machine)
      return patch(machine, { status: 'proposing', stream: { title: '', summary: '', tokens: 0 } }, [
        'propose.request',
        'emit-state',
      ])
    }

    case 'snapshot.fail': {
      if (machine.status !== 'reading') return noop(machine)
      return patch(
        machine,
        { status: 'failed', error: event.error ?? creatorError('E-HOST-01'), stream: null },
        ['audit-propose', 'persist-draft', 'emit-state'],
      )
    }

    case 'stream.delta': {
      if (machine.status !== 'proposing') return noop(machine)
      const current = machine.stream ?? { title: '', summary: '', tokens: 0 }
      return patch(
        machine,
        {
          stream: {
            title: event.title ?? current.title,
            summary: event.summary ?? current.summary,
            tokens: Math.max(current.tokens, event.tokens ?? current.tokens),
          },
        },
        ['emit-state'],
      )
    }

    case 'stream.done': {
      if (machine.status !== 'proposing') return noop(machine)
      if (typeof event.text !== 'string' || event.text.trim() === '') {
        return patch(
          machine,
          { status: 'failed', error: creatorError('E-PKG-01', 'empty model output'), stream: null },
          ['audit-propose', 'persist-draft', 'emit-state'],
        )
      }
      return patch(machine, {}, ['validate.request', 'emit-state'])
    }

    case 'proposal.valid': {
      const createdAt = event.createdAt ?? 0
      const entry: CreatorHistoryEntry = { revision: event.revision, proposal: event.proposal, createdAt }
      return patch(
        machine,
        {
          ...PROPOSAL_BASELINE,
          status: 'proposal-ready',
          draftId: event.draftId ?? machine.draftId,
          revision: event.revision,
          proposal: event.proposal,
          history: pushHistory(machine.history, entry),
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          template: null,
          restored: false,
        },
        ['persist-draft', 'persist-history', 'audit-propose', 'emit-state'],
      )
    }

    case 'proposal.invalid': {
      if (machine.status === 'idle') return noop(machine)
      return patch(machine, { status: 'failed', error: event.error, stream: null }, [
        'audit-propose',
        'persist-draft',
        'emit-state',
      ])
    }

    case 'template.start': {
      const entry: CreatorHistoryEntry = {
        revision: event.revision,
        proposal: event.proposal,
        createdAt: event.createdAt ?? 0,
      }
      return patch(
        machine,
        {
          ...PROPOSAL_BASELINE,
          status: 'proposal-ready',
          // 模板生成也是一次「提案」：沿用当前输入（可为空串），不覆盖用户已写的话。
          draftId: event.draftId ?? machine.draftId,
          revision: event.revision,
          proposal: event.proposal,
          history: pushHistory(machine.history, entry),
          template: event.templateId,
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          restored: false,
        },
        ['new-draft', 'persist-draft', 'persist-history', 'audit-propose', 'emit-state'],
      )
    }

    case 'history.pick': {
      const target = machine.history.find((item) => item.revision === event.revision)
      if (!target) return noop(machine)
      const stopTrial = isTrialActive(machine.status)
      return patch(
        machine,
        {
          status: 'proposal-ready',
          revision: target.revision,
          proposal: target.proposal,
          error: null,
          stream: null,
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          restored: false,
        },
        stopTrial ? ['trial.stop', 'persist-draft', 'emit-state'] : ['persist-draft', 'emit-state'],
      )
    }

    case 'trial.start': {
      // 04 §3.2 `reverted` 结果卡主按钮「再试一次」= 从撤销态直接再试跑；proposal-ready 同理。
      const startable = machine.status === 'proposal-ready' || machine.status === 'reverted'
      if (!startable || machine.proposal === null) return noop(machine)
      const grants = event.grants ?? trialGrantsOf(machine.proposal.capabilities)
      return patch(
        machine,
        {
          status: 'trialing',
          trial: {
            revision: machine.revision,
            startedAt: event.startedAt ?? 0,
            deckWrites: 0,
            granted: grants,
          },
          grantedCapabilities: grants,
          deckWrites: 0,
          error: null,
        },
        ['trial.start', 'audit-trial', 'persist-draft', 'emit-state'],
      )
    }

    case 'trial.deckwrite': {
      if (machine.status !== 'trialing' && machine.status !== 'applied') return noop(machine)
      const granted = machine.grantedCapabilities.includes('deck:write')
      if (!granted) {
        // 未授权：网关已拦；这里只记审计，不改变状态（S-40-03）。
        return patch(machine, { deckWrites: machine.deckWrites }, ['audit-trial', 'emit-state'])
      }
      const writes = Math.max(machine.deckWrites, event.deckWrites ?? machine.deckWrites + 1)
      return patch(
        machine,
        {
          status: 'applied',
          deckWrites: writes,
          trial: machine.trial ? { ...machine.trial, deckWrites: writes } : machine.trial,
        },
        ['audit-trial', 'persist-draft', 'emit-state'],
      )
    }

    case 'trial.crash': {
      if (!isTrialActive(machine.status) && machine.status !== 'proposal-ready') return noop(machine)
      return patch(
        machine,
        {
          status: 'failed',
          error: event.error ?? creatorError('E-RUN-02'),
          stream: null,
          trial: null,
        },
        ['trial.stop', 'audit-trial', 'persist-draft', 'emit-state'],
      )
    }

    case 'keep': {
      if (!isTrialActive(machine.status)) return noop(machine)
      // 安装管线是异步的：状态在 `keep.ok` / `keep.fail` 才变（04 §3.3）。
      return patch(machine, {}, ['install.request', 'audit-keep'])
    }

    case 'keep.ok': {
      return patch(
        machine,
        {
          status: 'saved',
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          error: null,
          stream: null,
        },
        ['trial.stop', 'persist-draft', 'audit-keep', 'emit-state'],
      )
    }

    case 'keep.fail': {
      // 失败不记 saved：回 proposal-ready + 错误卡，草稿保留（04 §3.2/§11 #13）。
      return patch(
        machine,
        {
          status: 'proposal-ready',
          error: event.error ?? creatorError('E-STORE-02'),
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
        },
        ['audit-keep', 'persist-draft', 'emit-state'],
      )
    }

    case 'revert': {
      if (!isTrialActive(machine.status) && machine.deckWrites === 0) return noop(machine)
      return patch(
        machine,
        {
          status: 'reverted',
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          error: null,
          stream: null,
        },
        ['trial.revert', 'audit-revert', 'persist-draft', 'emit-state'],
      )
    }

    case 'draft.discard': {
      return patch(
        machine,
        {
          ...initialCreatorMachine(),
          status: 'idle',
        },
        ['trial.stop', 'drop.draft', 'audit-revert', 'emit-state'],
      )
    }

    case 'cancel': {
      if (machine.status !== 'reading' && machine.status !== 'proposing') return noop(machine)
      return patch(
        machine,
        {
          status: machine.proposal ? 'proposal-ready' : 'idle',
          stream: null,
          error: null,
          trial: null,
          grantedCapabilities: [],
        },
        ['cancel.request', 'persist-draft', 'emit-state'],
      )
    }

    case 'retry': {
      if (machine.status !== 'failed') return noop(machine)
      return patch(machine, { status: 'reading', error: null, stream: null }, ['propose.request', 'emit-state'])
    }

    case 'grant.deckWrite': {
      if (!machine.proposal) return noop(machine)
      const allowed = machine.proposal.capabilities.includes('deck:write')
      if (!allowed) return noop(machine)
      const base = machine.grantedCapabilities.filter((capability) => capability !== 'deck:write')
      const granted = event.granted ? [...base, 'deck:write' as Capability] : base
      return patch(
        machine,
        {
          grantedCapabilities: granted,
          trial: machine.trial ? { ...machine.trial, granted } : machine.trial,
        },
        ['audit-trial', 'persist-draft', 'emit-state'],
      )
    }

    case 'resume.boot': {
      const record = event.record
      const base: CreatorMachine = {
        ...initialCreatorMachine(),
        prompt: '',
        draftId: record.draftId,
        revision: record.revision,
        proposal: record.proposal,
        history: record.history.slice(-MAX_CREATOR_HISTORY),
        template: record.template ?? null,
        restored: true,
        interrupted: false,
      }
      switch (record.status) {
        case 'saved':
          return patch(base, { status: 'saved' }, ['emit-state'])
        case 'reverted':
          return patch(base, { status: 'reverted' }, ['emit-state'])
        case 'failed':
          return patch(base, { status: 'failed', error: record.error ?? creatorError('E-HOST-01') }, [
            'emit-state',
          ])
        case 'trialing':
        case 'applied':
          // 帧随刷新销毁，绝不自动重挂；状态回 proposal-ready 并标记中断（04 §3.5）。
          return patch(
            base,
            {
              status: 'proposal-ready',
              interrupted: true,
              trial: null,
              grantedCapabilities: [],
              deckWrites: 0,
            },
            ['emit-state'],
          )
        case 'interrupted':
          return patch(base, { status: 'proposal-ready', interrupted: true }, ['emit-state'])
        case 'proposal-ready':
        default:
          return patch(base, { status: 'proposal-ready' }, ['emit-state'])
      }
    }

    default:
      return noop(machine)
  }
}

/* ============================ 对外钩子 ============================ */

export interface CreatorHookState {
  state: CreatorPublicState
  outcome?: CreatorOutcome
}

/** 04 §3.4 的映射（单测 CR-40-02 钉死）。 */
export function creatorHookState(machine: CreatorMachine): CreatorHookState {
  const state = PUBLIC_STATE_BY_STATUS[machine.status]
  const outcome = outcomeOf(machine.status)
  return outcome ? { state, outcome } : { state }
}

/**
 * `data-creator-*` 属性集合（06 §3.1 冻结）。
 * 只返回「当前该出现」的属性：空值不渲染，避免 e2e 读到误导值。
 */
export function creatorStateAttrs(machine: CreatorMachine): Record<string, string> {
  const hook = creatorHookState(machine)
  const attrs: Record<string, string> = { 'data-creator-state': hook.state }
  if (hook.outcome) attrs['data-creator-outcome'] = hook.outcome
  if (machine.draftId) attrs['data-creator-draft'] = machine.draftId
  if (machine.revision > 0) attrs['data-creator-revision'] = String(machine.revision)
  // `data-creator-proposal` 只挂在提案卡（ProposalView）：06 §3.1 的 locator 必须唯一（e2e strict mode）。
  if (machine.error) attrs['data-creator-error'] = machine.error.code
  // data-creator-template 只在模板按钮上（e2e 用 first() 取当前偏好）；根节点用 -id 区分。
  if (machine.template) attrs['data-creator-template-id'] = machine.template
  if (machine.restored) attrs['data-creator-restored'] = '1'
  if (machine.stream) attrs['data-creator-stream'] = '1'
  if (machine.deckWrites > 0) attrs['data-creator-deck-writes'] = String(machine.deckWrites)
  if (machine.interrupted) attrs['data-creator-interrupted'] = '1'
  return attrs
}

/** 状态条文案键（`creator.state.*`，04 §9.2）。 */
export function creatorStatusMessageKey(status: CreatorStatus): string {
  switch (status) {
    case 'idle':
      return 'creator.state.idle'
    case 'reading':
      return 'creator.state.reading'
    case 'proposing':
      return 'creator.state.proposing'
    case 'proposal-ready':
      return 'creator.state.proposalReady'
    case 'trialing':
      return 'creator.state.trialing'
    case 'applied':
      return 'creator.state.applied'
    case 'saved':
      return 'creator.state.saved'
    case 'reverted':
      return 'creator.state.reverted'
    case 'failed':
      return 'creator.state.failed'
  }
}
