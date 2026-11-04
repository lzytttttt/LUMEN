/**
 * creator/persistence.ts —— 草稿与版本历史的本地持久化（04 §3.5 / §5.4 / §13.1）。
 *
 * 存储（02 §7.2，DB v4 `creator` store）：
 * - `draft/<draftId>`  → `PluginDraft`（当前草稿）
 * - `history/<draftId>` → `PluginDraft[]`（最近 10 版，超丢最旧）
 *
 * 三条硬规则（04 §3.5）：不自动试跑、不自动安装、恢复过程零 ops 调用（不写 deck）。
 * IDB 不可用时 kv 层自动降级内存模式，这里不需要探测。
 */
import { kvDel, kvGet, kvKeys, kvSet } from '@/persistence/kv'
import type { CreatorProposal, PluginDraft, PluginDraftStatus, PluginManifest, PluginTrial } from '@/plugins/types'
import { parseProposalManifest, proposalDigest } from './proposal'
import { creatorLastDraftId, patchCreatorSettings } from './settings'
import type { CreatorHistoryEntry, CreatorMachine } from './state'
import { MAX_CREATOR_HISTORY } from './state'
import { draftKeyOf, isUlid } from './id'

/** 草稿保留期（04 §13.1：30 天）。 */
export const CREATOR_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 历史版上限（04 §5.4）。 */
export const CREATOR_HISTORY_LIMIT = MAX_CREATOR_HISTORY
/** 记录 schema 版本锚点（损坏/不识别一律丢弃，04 §3.5）。 */
export const CREATOR_DRAFT_SCHEMA = 1

export interface CreatorDraftRecord extends PluginDraft {
  /** 本模块写的锚点版本；旧/坏记录因此可识别。 */
  schema?: number
}

/** 历史 key（`history/<draftId>`）。 */
export function historyKeyOf(draftId: string): string {
  return `history/${draftId}`
}

/* ------------------------------ 记录构造 ------------------------------ */

function safeManifest(proposal: CreatorProposal): PluginManifest | null {
  try {
    return parseProposalManifest(proposal.files)
  } catch {
    return null
  }
}

export interface BuildDraftInput {
  draftId: string
  revision: number
  status: PluginDraftStatus
  proposal: CreatorProposal
  request?: string
  trials?: PluginTrial[]
  grantedCapabilities?: PluginDraft['grantedCapabilities']
  createdAt?: number
  updatedAt?: number
  digest?: string
}

/** 由提案构造一条可落库草稿；清单无法解析时返回 null（不写坏记录）。 */
export async function buildDraftRecord(input: BuildDraftInput): Promise<CreatorDraftRecord | null> {
  if (!isUlid(input.draftId)) return null
  const manifest = safeManifest(input.proposal)
  if (!manifest) return null
  const digest = input.digest ?? (await proposalDigest(input.proposal))
  const now = input.updatedAt ?? Date.now()
  return {
    schema: CREATOR_DRAFT_SCHEMA,
    draftId: input.draftId,
    root: `draft/${input.draftId}`,
    revision: input.revision,
    status: input.status,
    proposal: input.proposal,
    files: input.proposal.files.map((file) => ({ path: file.path, content: file.content })),
    manifest,
    trials: (input.trials ?? []).slice(-40),
    grantedCapabilities: input.grantedCapabilities ?? [],
    proposalDigest: digest,
    request: input.request,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
}

/* ------------------------------ 读 / 写 ------------------------------ */

const DRAFT_STATUSES: readonly PluginDraftStatus[] = [
  'proposal-ready',
  'trialing',
  'applied',
  'failed',
  'saved',
  'reverted',
  'interrupted',
]

/** 宽松但足够严格的形状校验（不认识的字段不拒绝，坏字段直接判损坏）。 */
export function isCreatorDraftRecord(value: unknown): value is CreatorDraftRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CreatorDraftRecord>
  if (typeof record.draftId !== 'string' || !isUlid(record.draftId)) return false
  if (typeof record.revision !== 'number' || record.revision < 0) return false
  if (typeof record.status !== 'string' || !(DRAFT_STATUSES as readonly string[]).includes(record.status)) return false
  if (!record.proposal || typeof record.proposal !== 'object') return false
  if (typeof record.proposal.title !== 'string') return false
  if (!Array.isArray(record.proposal.files) || record.proposal.files.length === 0) return false
  if (!Array.isArray(record.files) || record.files.length === 0) return false
  if (!record.manifest || typeof record.manifest !== 'object') return false
  if (!Array.isArray(record.trials)) return false
  if (!Array.isArray(record.grantedCapabilities)) return false
  if (typeof record.createdAt !== 'number') return false
  return true
}

function isExpired(record: CreatorDraftRecord, now = Date.now()): boolean {
  return now - record.createdAt > CREATOR_DRAFT_TTL_MS
}

export async function loadCreatorDraft(draftId: string, now = Date.now()): Promise<CreatorDraftRecord | null> {
  if (!isUlid(draftId)) return null
  const record = await kvGet<unknown>('creator', draftKeyOf(draftId))
  if (!isCreatorDraftRecord(record)) return null
  if (isExpired(record, now)) return null
  return record
}

/** 保存草稿；成功返回 true（IDB 失败/内存模式返回 false，由 UI 提示 E-STORE-02）。 */
export async function saveCreatorDraft(record: CreatorDraftRecord): Promise<boolean> {
  if (!isCreatorDraftRecord(record)) return false
  const ok = await kvSet('creator', draftKeyOf(record.draftId), record)
  patchCreatorSettings({ lastDraftId: record.draftId })
  return ok
}

/** 从状态机快照落一份草稿（`persist-draft` 副作用）。 */
export async function persistCreatorMachine(
  machine: CreatorMachine,
  options: { trials?: PluginTrial[]; status?: PluginDraftStatus; createdAt?: number } = {},
): Promise<boolean> {
  if (!machine.draftId || !machine.proposal) return false
  const manifest = safeManifest(machine.proposal)
  if (!manifest) return false
  const existing = await loadCreatorDraft(machine.draftId).catch(() => null)
  const record = await buildDraftRecord({
    draftId: machine.draftId,
    revision: machine.revision,
    status: options.status ?? statusOfMachine(machine),
    proposal: machine.proposal,
    request: machine.prompt || existing?.request,
    trials: options.trials ?? existing?.trials ?? [],
    grantedCapabilities: machine.grantedCapabilities,
    createdAt: options.createdAt ?? existing?.createdAt,
  })
  if (!record) return false
  return saveCreatorDraft(record)
}

function statusOfMachine(machine: CreatorMachine): PluginDraftStatus {
  switch (machine.status) {
    case 'trialing':
      return 'trialing'
    case 'applied':
      return 'applied'
    case 'saved':
      return 'saved'
    case 'reverted':
      return 'reverted'
    case 'failed':
      return 'failed'
    case 'idle':
    case 'reading':
    case 'proposing':
    case 'proposal-ready':
    default:
      return 'proposal-ready'
  }
}

/** 历史落库（`PluginDraft[]` ≤10；条目本身是提案快照，不含用户原话）。 */
export async function saveCreatorHistory(
  draftId: string,
  entries: CreatorHistoryEntry[],
  now = Date.now(),
): Promise<boolean> {
  if (!isUlid(draftId)) return false
  const trimmed = [...entries].sort((a, b) => a.revision - b.revision).slice(-CREATOR_HISTORY_LIMIT)
  const records: CreatorDraftRecord[] = []
  for (const entry of trimmed) {
    const record = await buildDraftRecord({
      draftId,
      revision: entry.revision,
      status: 'proposal-ready',
      proposal: entry.proposal,
      createdAt: entry.createdAt || now,
      updatedAt: entry.createdAt || now,
    })
    if (record) records.push(record)
  }
  return kvSet('creator', historyKeyOf(draftId), records)
}

export async function loadCreatorHistory(draftId: string, now = Date.now()): Promise<CreatorHistoryEntry[]> {
  if (!isUlid(draftId)) return []
  const raw = await kvGet<unknown>('creator', historyKeyOf(draftId))
  if (!Array.isArray(raw)) return []
  const entries: CreatorHistoryEntry[] = []
  for (const item of raw) {
    if (!isCreatorDraftRecord(item)) continue
    if (isExpired(item, now)) continue
    entries.push({ revision: item.revision, proposal: item.proposal, createdAt: item.createdAt })
  }
  return entries.sort((a, b) => a.revision - b.revision).slice(-CREATOR_HISTORY_LIMIT)
}

/** 追加一条试跑记录（试跑开始/结束/中断时调用；短路保留最近 40 条）。 */
export async function appendCreatorTrial(draftId: string, trial: PluginTrial): Promise<boolean> {
  const record = await loadCreatorDraft(draftId)
  if (!record) return false
  const next: CreatorDraftRecord = {
    ...record,
    trials: [...record.trials.filter((item) => item.revision !== trial.revision || item.outcome === 'trialing'), trial].slice(-40),
    updatedAt: Date.now(),
  }
  return saveCreatorDraft(next)
}

/** 丢弃草稿：删 `draft/` 与 `history/` 两个 key，并清指针（04 §3.3 draft.discard）。 */
export async function dropCreatorDraft(draftId: string): Promise<void> {
  if (!isUlid(draftId)) return
  await kvDel('creator', draftKeyOf(draftId))
  await kvDel('creator', historyKeyOf(draftId))
  if (creatorLastDraftId() === draftId) patchCreatorSettings({ lastDraftId: null })
}

/** 设置→数据→清除创造数据（02 §7.5「恢复默认工作台」用）。 */
export async function clearCreatorData(): Promise<void> {
  const lastId = creatorLastDraftId()
  if (lastId) {
    await dropCreatorDraft(lastId)
  }
  patchCreatorSettings({ lastDraftId: null, readDeck: false })
}

/* ------------------------------ 刷新恢复（04 §3.5） ------------------------------ */

/** 最近写过的草稿 id（指针丢失时的兜底；未过期、形状合法才认）。 */
export async function newestCreatorDraftId(now = Date.now()): Promise<string | null> {
  const keys = await kvKeys('creator').catch(() => [] as string[])
  let best: { draftId: string; updatedAt: number } | null = null
  for (const key of keys) {
    if (!key.startsWith('draft/')) continue
    const draftId = key.slice('draft/'.length)
    const record = await loadCreatorDraft(draftId, now).catch(() => null)
    if (!record) continue
    const updatedAt = record.updatedAt ?? record.createdAt
    if (!best || updatedAt > best.updatedAt) best = { draftId, updatedAt }
  }
  return best?.draftId ?? null
}

export type CreatorRestoreResult =
  | { status: 'empty' }
  | { status: 'corrupt'; draftId: string }
  | {
      status: 'restored'
      record: CreatorDraftRecord
      history: CreatorHistoryEntry[]
      /** 刷新前处于试跑/已应用：界面回 proposal-ready + 「上次试跑已中断」。 */
      interrupted: boolean
    }

/**
 * 启动恢复：按 `settings.plugins.creator.lastDraftId` 读草稿。
 * - 指针丢失（例如保留后 400ms 设置防抖未落库就刷新）→ 回退扫 `creator` store 里最新的 `draft/<id>`；
 * - 记录损坏/版本不识别 → 删 key + 清指针（UI toast「草稿无法读取」）；
 * - trialing/applied → 草稿改 `status='interrupted'` + `trials[]` 追加一条（帧随刷新销毁，绝不自动重挂）。
 */
export async function restoreCreatorDraft(now = Date.now()): Promise<CreatorRestoreResult> {
  let draftId = creatorLastDraftId()
  if (!draftId) {
    draftId = await newestCreatorDraftId(now)
    if (!draftId) return { status: 'empty' }
  }
  if (!isUlid(draftId)) {
    patchCreatorSettings({ lastDraftId: null })
    return { status: 'corrupt', draftId }
  }
  const record = await loadCreatorDraft(draftId, now)
  if (!record) {
    await kvDel('creator', draftKeyOf(draftId))
    await kvDel('creator', historyKeyOf(draftId))
    patchCreatorSettings({ lastDraftId: null })
    return { status: 'corrupt', draftId }
  }
  const history = await loadCreatorHistory(draftId, now)
  const interrupted = record.status === 'trialing' || record.status === 'applied'
  if (interrupted) {
    const trial: PluginTrial = { revision: record.revision, at: now, outcome: 'interrupted' }
    const updated: CreatorDraftRecord = {
      ...record,
      status: 'interrupted',
      trials: [...record.trials, trial].slice(-40),
      updatedAt: now,
    }
    await kvSet('creator', draftKeyOf(draftId), updated)
    return { status: 'restored', record: updated, history, interrupted: true }
  }
  return { status: 'restored', record, history, interrupted: false }
}
