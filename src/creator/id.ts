/**
 * creator/id.ts —— 草稿 id（ULID）纯函数（04 §5.2 / §8.1，CR-40-22）。
 *
 * 规格：26 字符 Crockford Base32 —— 10 位时间戳（48 bit）+ 16 位随机（80 bit）。
 * 为什么不用 `crypto.randomUUID`：ULID 可按时间排序、无依赖、大小写稳定，
 * 且 `draft/<draftId>` 要进 IDB key 与帧 id（`draft/<id>@<rev>`），字符集必须可预测。
 *
 * 纪律：本文件零依赖；`now`/`rng` 可注入，单测因此完全确定。
 */

/** Crockford Base32：去掉 I/L/O/U，避免与 1/0 混淆。 */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const

export const ULID_LENGTH = 26
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
/** 48 bit 时间戳上限（约公元 10889 年）。 */
const MAX_TIME = 2 ** 48 - 1

function encodeBase32(value: number, length: number, alphabet: string): string {
  let remaining = Math.max(0, Math.floor(value))
  let out = ''
  for (let index = 0; index < length; index += 1) {
    const mod = remaining % 32
    out = alphabet[mod] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

/** 10 位时间戳前缀（毫秒）。 */
export function encodeTime(now: number): string {
  return encodeBase32(Math.min(MAX_TIME, Math.max(0, now)), TIME_LENGTH, CROCKFORD)
}

/**
 * 16 位随机后缀。`rng` 返回值约定与 `Math.random` 一致（[0,1)）；
 * 注入固定序列即可得到确定输出（单测用）。
 */
export function encodeRandom(rng: () => number = Math.random): string {
  let out = ''
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    const sample = Math.min(0.999999999, Math.max(0, rng()))
    out += CROCKFORD[Math.floor(sample * 32)]
  }
  return out
}

/** 生成 26 字符 ULID。 */
export function ulid(now: number = Date.now(), rng: () => number = Math.random): string {
  return encodeTime(now) + encodeRandom(rng)
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 是否是合法 ULID（大小写不敏感，返回前统一大写由调用方负责）。 */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value.toUpperCase())
}

/** 草稿 id → store key（`draft/<draftId>`，04 §5.2）。 */
export function draftKeyOf(draftId: string): string {
  return `draft/${draftId}`
}

/** 草稿 id → 虚拟 registry pluginId（02 §11.5.1）。 */
export function draftPluginIdOf(draftId: string): string {
  return `draft/${draftId}`
}

/** 帧 id：`draft/<draftId>@<revision>`（02 §11.5.1，与 `${pluginId}@${revision}` 同式）。 */
export function draftFrameIdOf(draftId: string, revision: number): string {
  return `${draftPluginIdOf(draftId)}@${revision}`
}

/** 从帧 id 拆回 `{ draftId, revision }`；非法返回 null。 */
export function parseDraftFrameId(frameId: string): { draftId: string; revision: number } | null {
  const match = /^draft\/([0-9A-Za-z]{1,64})@(\d{1,6})$/.exec(frameId)
  if (!match) return null
  return { draftId: match[1], revision: Number(match[2]) }
}
