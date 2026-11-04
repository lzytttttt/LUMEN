/**
 * creator/publish.ts —— 把草稿打包成 `.lumenplug`（04 §5.2 / §12.3 / 02 §2.2）。
 *
 * 口径：
 * - 提案期 `CreatorProposal.files` 可含 `.lumen-plugin.json`（预览/校验用）；
 * - 打包时**剥离**该文件并提升为信封 `manifest` 字段（不进 `files`）；
 * - canonical JSON / sha256 / 信封构造**复用** `@/plugins/package`，本文件不另写实现。
 */
import type { CreatorProposal, PluginEnvelope, PluginManifest } from '@/plugins/types'
import { MANIFEST_FILE_NAME, buildEnvelope, serializeEnvelope, bytesOf } from '@/plugins/package'
import { parseProposalManifest } from './proposal'

export interface LumenplugBuild {
  envelope: PluginEnvelope
  /** 可直接下载/落盘的 canonical JSON 文本。 */
  json: string
  bytes: number
}

export class CreatorPublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CreatorPublishError'
  }
}

/** 提案 → 信封（剥离清单、保留其余文件；integrity 由 plugins/package 计算）。 */
export async function buildLumenplug(
  proposal: CreatorProposal,
  options: { createdAt?: number; manifest?: PluginManifest } = {},
): Promise<LumenplugBuild> {
  const manifest = options.manifest ?? safeManifestOf(proposal)
  const files: Record<string, string> = {}
  for (const file of proposal.files) {
    if (file.path === MANIFEST_FILE_NAME) continue
    files[file.path] = file.content
  }
  const envelope = await buildEnvelope({ manifest, files, createdAt: options.createdAt })
  const json = serializeEnvelope(envelope)
  return { envelope, json, bytes: bytesOf(json) }
}

function safeManifestOf(proposal: CreatorProposal): PluginManifest {
  try {
    return parseProposalManifest(proposal.files)
  } catch (error) {
    throw new CreatorPublishError(error instanceof Error ? error.message : 'manifest 无法解析')
  }
}

/** 导出文件名（`.lumenplug`；只取 manifest id 的末段，避免泄露命名空间路径）。 */
export function suggestFileName(manifest: PluginManifest): string {
  const slug = manifest.id.split('.').pop() ?? 'plugin'
  return `${slug.replace(/[^a-z0-9-]/gi, '-')}-${manifest.version}.lumenplug`
}

/** 浏览器下载（测试环境 jsdom 里也可 spawn 一个 anchor，不做断言）。 */
export function downloadLumenplug(build: LumenplugBuild, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob = new Blob([build.json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 打包 + 下载（UI「导出插件」按钮的唯一步骤；失败抛 `CreatorPublishError`）。 */
export async function exportLumenplug(
  proposal: CreatorProposal,
  options: { createdAt?: number } = {},
): Promise<{ fileName: string; build: LumenplugBuild }> {
  const build = await buildLumenplug(proposal, options)
  const fileName = suggestFileName(build.envelope.manifest)
  downloadLumenplug(build, fileName)
  return { fileName, build }
}
