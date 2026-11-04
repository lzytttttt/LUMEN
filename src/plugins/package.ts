/**
 * plugins/package.ts —— `.lumenplug` 信封的解析、canonical JSON、sha256 与体积/路径校验。
 *
 * 契约：plan/v0.4.0/02 §2.1–§2.4、03 §6.1。零新增依赖：
 * - canonical JSON 自写（规则见 `canonicalJson`）；
 * - sha256 走 `crypto.subtle`（非安全上下文拒绝安装，不做弱校验，02 §2.4）；
 * - 读包/校验全部返回 `PluginError`，错误码对应 §5.5。
 */
import { PluginError, INTEGRITY_UNSUPPORTED } from './errors'
import type {
  PluginEnvelope,
  PluginEnvelopePayload,
  PluginManifest,
} from './types'

/** 便利再导出：夹具/打包脚本常直接 `import type { PluginEnvelope } from '@/plugins/package'`。 */
export type { PluginEnvelope, PluginEnvelopePayload, PluginManifest, PluginPackagePreview, InstallOutcome } from './types'

/* ------------------------------ 冻结常量（02 §2.2） ------------------------------ */

export const PACKAGE_LIMITS = {
  /** 信封 UTF-8 总字节数上限。 */
  maxBytes: 2_000_000,
  /** 文件数上限。 */
  maxFiles: 64,
  /** 单文件上限。 */
  maxFileBytes: 512_000,
  /** 入口文件上限。 */
  maxEntryBytes: 256_000,
  /** 图标上限（`E-MAN-11`）。 */
  maxIconBytes: 64 * 1024,
  /** 路径深度上限（含文件名）。 */
  maxDepth: 3,
} as const

export const PACKAGE_FORMAT = 'lumen-plugin'
export const PACKAGE_FORMAT_VERSION = 1 as const
export const INTEGRITY_PATTERN = /^sha256:[0-9a-f]{64}$/
/** 允许的文本扩展名（02 §2.2）。 */
export const ALLOWED_FILE_EXTENSIONS = ['js', 'mjs', 'json', 'svg', 'css', 'md', 'txt'] as const

const PATH_PATTERN = /^(?:[a-z0-9][a-z0-9._-]*\/){0,2}[a-z0-9][a-z0-9._-]*$/
/** 信封 files 不允许出现的源工程清单（02 §2.2 脚注）。 */
export const MANIFEST_FILE_NAME = '.lumen-plugin.json'
const MIN_CREATED_AT = Date.UTC(2020, 0, 1)
const MAX_CREATED_AT_SKEW_MS = 86_400_000

/* ------------------------------ canonical JSON（02 §2.4） ------------------------------ */

const MAX_CANONICAL_DEPTH = 64

/**
 * canonical JSON（02 §2.4 六条规则）：
 * 1. 对象键按 UTF-16 code unit 升序递归排序，数组保持原序；
 * 2. 无任何空白；
 * 3. 字符串最小转义：`"`、`\`、`\u0000`–`\u001f` 用 `\uXXXX`，非 ASCII 原样；
 * 4. 数字：-0 归一为 0；NaN/Infinity/非安全整数 → `E-PKG-01`；
 * 5. `undefined`/函数/symbol/BigInt/非纯对象一律拒绝；
 * 6. 顶层 payload 由调用方（`integrityOf`）保证形状。
 *
 * 注：契约规则 4 写「浮点一律拒绝」，但 manifest 的 `typeScale/glow/colors` 等合法字段允许浮点；
 * 实施口径 = 允许**有限浮点**（按 JS 最短往返表示序列化，跨平台字节稳定），仍拒绝 NaN/Infinity/非安全整数。
 */
export function canonicalJson(value: unknown): string {
  return encodeValue(value, 0)
}

function encodeValue(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new PluginError('E-PKG-01', 'canonical json: nesting too deep')
  }
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return encodeString(value)
    case 'number':
      return encodeNumber(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new PluginError('E-PKG-01', `canonical json: unsupported value (${typeof value})`)
    case 'object':
      break
    default:
      throw new PluginError('E-PKG-01', 'canonical json: unsupported value')
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new PluginError('E-PKG-01', 'canonical json: sparse array or unsupported item')
      }
      parts.push(encodeValue(item, depth + 1))
    }
    return `[${parts.join(',')}]`
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PluginError('E-PKG-01', 'canonical json: non-plain object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = record[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      throw new PluginError('E-PKG-01', `canonical json: unsupported value at "${key}"`)
    }
    parts.push(`${encodeString(key)}:${encodeValue(item, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PluginError('E-PKG-01', 'canonical json: NaN/Infinity is not allowed')
  }
  if (Object.is(value, -0)) return '0'
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new PluginError('E-PKG-01', 'canonical json: integer exceeds safe range')
  }
  return JSON.stringify(value)
}

function encodeString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    const code = value.charCodeAt(i)
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += char + value[i + 1]
        i += 1
      } else out += `\\u${code.toString(16)}`
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += `\\u${code.toString(16)}`
    } else out += char
  }
  return `${out}"`
}

/* ------------------------------ 字节 / 摘要 ------------------------------ */

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** UTF-8 字节数（02 §2.2 全部体积口径共用）。 */
export function bytesOf(text: string): number {
  if (encoder) return encoder.encode(text).length
  return new Blob([text]).size
}

function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function subtleCrypto(): SubtleCrypto | null {
  const candidate = (globalThis as { crypto?: Crypto }).crypto
  return candidate && candidate.subtle ? candidate.subtle : null
}

/**
 * sha256 → 小写 hex（无前缀）。
 * 非安全上下文（`crypto.subtle` 不可用）→ `E-PKG-05`，detail=`integrityUnsupported`（02 §2.4）。
 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = subtleCrypto()
  if (!subtle) {
    throw new PluginError('E-PKG-05', 'SHA-256 is unavailable in this context', INTEGRITY_UNSUPPORTED)
  }
  const data =
    typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(input)
      : new Uint8Array(await new Blob([input]).arrayBuffer())
  const digest = await subtle.digest('SHA-256', data)
  return hexOf(digest)
}

/** `sha256Hex` 的别名（creator/04 用）。 */
export const sha256 = sha256Hex

/** `'sha256:' + hex`（.lumenplug 信封 integrity 字段口径）。 */
export async function integrityOf(payload: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(payload))}`
}

/* ------------------------------ 信封 ------------------------------ */

const ENVELOPE_KEYS = ['format', 'formatVersion', 'createdAt', 'integrity', 'manifest', 'files'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 02 §2.4 规则 6：信封里参与 integrity 的 payload 形状。 */
export function payloadOf(envelope: PluginEnvelope): PluginEnvelopePayload {
  return {
    format: envelope.format,
    formatVersion: envelope.formatVersion,
    createdAt: envelope.createdAt,
    manifest: envelope.manifest,
    files: envelope.files,
  }
}

/**
 * 解析信封（02 §3.1 步骤 2 + 02 §2.2 文件规则；不含 manifest zod 校验，也不校验 integrity）。
 * 复杂度 O(文件数 + 总体积)。
 */
export function parseEnvelope(text: string, opts?: { maxBytes?: number }): PluginEnvelope {
  const maxBytes = opts?.maxBytes ?? PACKAGE_LIMITS.maxBytes
  const size = bytesOf(text)
  if (size > maxBytes) {
    throw new PluginError('E-PKG-04', `package is ${size} bytes (limit ${maxBytes})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new PluginError('E-PKG-01', 'package is not valid JSON', String(error))
  }
  if (!isPlainObject(raw)) throw new PluginError('E-PKG-01', 'package must be a JSON object')

  for (const key of Object.keys(raw)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
      throw new PluginError('E-PKG-01', `unknown envelope field "${key}"`)
    }
  }
  if (raw.format !== PACKAGE_FORMAT) {
    throw new PluginError('E-PKG-02', 'envelope format must be "lumen-plugin"')
  }
  if (raw.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new PluginError('E-PKG-02', `unsupported formatVersion ${String(raw.formatVersion)}`)
  }
  const now = Date.now()
  const createdAt = raw.createdAt
  if (
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < MIN_CREATED_AT ||
    createdAt > now + MAX_CREATED_AT_SKEW_MS
  ) {
    throw new PluginError('E-PKG-01', 'createdAt is out of range')
  }
  if (typeof raw.integrity !== 'string' || !INTEGRITY_PATTERN.test(raw.integrity)) {
    throw new PluginError('E-PKG-01', 'integrity must look like "sha256:<64 lowercase hex>"')
  }
  if (!isPlainObject(raw.manifest)) throw new PluginError('E-PKG-03', 'missing manifest')
  if (!isPlainObject(raw.files)) throw new PluginError('E-PKG-03', 'missing files')

  const files = raw.files as Record<string, unknown>
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      throw new PluginError('E-PKG-01', `file "${path}" must be a UTF-8 string (binary is not allowed)`)
    }
  }
  const manifest = raw.manifest as unknown as PluginManifest
  const entry = typeof manifest.entry === 'string' ? manifest.entry : undefined
  validateFiles(files as Record<string, string>, { entry })

  return {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    createdAt,
    integrity: raw.integrity,
    manifest,
    files: files as Record<string, string>,
  }
}

/** 文件路径 / 扩展名 / 体积校验（02 §2.2），失败抛 `E-PKG-06` / `E-PKG-04`。 */
export function validateFiles(
  files: Record<string, string>,
  opts?: { entry?: string; maxFiles?: number; maxFileBytes?: number },
): void {
  const names = Object.keys(files)
  const maxFiles = opts?.maxFiles ?? PACKAGE_LIMITS.maxFiles
  if (names.length === 0) throw new PluginError('E-PKG-03', 'package has no files')
  if (names.length > maxFiles) {
    throw new PluginError('E-PKG-04', `too many files (${names.length} > ${maxFiles})`)
  }
  const maxFileBytes = opts?.maxFileBytes ?? PACKAGE_LIMITS.maxFileBytes
  for (const path of names) {
    validatePath(path)
    const bytes = bytesOf(files[path])
    if (bytes > maxFileBytes) {
      throw new PluginError('E-PKG-04', `file "${path}" is too large (${bytes} > ${maxFileBytes})`)
    }
    const limit = path === opts?.entry ? PACKAGE_LIMITS.maxEntryBytes : maxFileBytes
    if (bytes > limit) {
      throw new PluginError('E-PKG-04', `file "${path}" is too large (${bytes} > ${limit})`)
    }
    if (path === MANIFEST_FILE_NAME) {
      throw new PluginError('E-PKG-06', '.lumen-plugin.json must be lifted into envelope.manifest')
    }
  }
  if (opts?.entry !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(files, opts.entry)) {
      throw new PluginError('E-MAN-06', `entry "${opts.entry}" is not present in files`)
    }
    if (!/\.(?:js|mjs)$/.test(opts.entry)) {
      throw new PluginError('E-MAN-06', 'entry must be a .js or .mjs file')
    }
  }
}

/** 单条路径校验（02 §2.2）。 */
export function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 160) {
    throw new PluginError('E-PKG-06', `invalid file path "${String(path)}"`)
  }
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new PluginError('E-PKG-06', `absolute path or backslash is not allowed: "${path}"`)
  }
  const segments = path.split('/')
  if (segments.length > PACKAGE_LIMITS.maxDepth) {
    throw new PluginError('E-PKG-06', `path is nested too deep: "${path}"`)
  }
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new PluginError('E-PKG-06', `path traversal is not allowed: "${path}"`)
  }
  if (segments.some((segment) => segment.toLowerCase() === 'node_modules')) {
    throw new PluginError('E-PKG-06', `node_modules is not allowed: "${path}"`)
  }
  if (!PATH_PATTERN.test(path)) {
    throw new PluginError('E-PKG-06', `invalid file path pattern: "${path}"`)
  }
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (!(ALLOWED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new PluginError('E-PKG-06', `file extension ".${ext}" is not allowed`)
  }
}

/**
 * 校验 integrity（02 §3.1 步骤 3）。三处调用：安装写库前 / 每次启用重算 / 导出前。
 */
export async function verifyIntegrity(envelope: PluginEnvelope): Promise<void> {
  const actual = await integrityOf(payloadOf(envelope))
  if (actual !== envelope.integrity) {
    throw new PluginError('E-PKG-05', 'integrity mismatch: package may be corrupted or modified')
  }
}

/** 组装信封并算 integrity（创造模式 publish、夹具与样例打包共用）。 */
export async function buildEnvelope(input: {
  manifest: PluginManifest
  files: Record<string, string>
  createdAt?: number
}): Promise<PluginEnvelope> {
  const createdAt = input.createdAt ?? Date.now()
  const payload: PluginEnvelopePayload = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    createdAt,
    manifest: input.manifest,
    files: input.files,
  }
  return { ...payload, integrity: await integrityOf(payload) }
}

/** 信封序列化（canonical，保证字节稳定；`.lumenplug` = 该字符串的 UTF-8 字节）。 */
export function serializeEnvelope(envelope: PluginEnvelope): string {
  return canonicalJson(envelope)
}

/* ------------------------------ 读包（三入口） ------------------------------ */

export type EnvelopeInput = string | Blob | ArrayBuffer | Uint8Array

function isBlobLike(value: unknown): value is Blob {
  return !!value && typeof value === 'object' && typeof (value as Blob).text === 'function' && typeof (value as Blob).size === 'number'
}

/**
 * 02 §3.1 步骤 1–2：读入 + 解析 + 文件校验（≤2MB，超限先断流）。
 * 输入可以是原始文本、File/Blob、ArrayBuffer。
 */
export async function readEnvelope(input: EnvelopeInput, opts?: { maxBytes?: number }): Promise<PluginEnvelope> {
  const maxBytes = opts?.maxBytes ?? PACKAGE_LIMITS.maxBytes
  if (typeof input === 'string') return parseEnvelope(input, { maxBytes })
  if (isBlobLike(input)) {
    if (input.size > maxBytes) {
      throw new PluginError('E-PKG-04', `package is ${input.size} bytes (limit ${maxBytes})`)
    }
    const text = await input.text()
    return parseEnvelope(text, { maxBytes })
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength > maxBytes) {
    throw new PluginError('E-PKG-04', `package is ${bytes.byteLength} bytes (limit ${maxBytes})`)
  }
  return parseEnvelope(new TextDecoder().decode(bytes), { maxBytes })
}

/** URL 安装：仅 https（回环地址允许 http，便于本机 e2e/开发；03 §6.1 防中间人）。 */
export function isInstallableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return true
    return false
  } catch {
    return false
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** 02 §3.1 步骤 1 的 URL 分支（`E-NET-01`；不自动重试、跟随重定向关闭）。 */
export async function readEnvelopeFromUrl(url: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PluginEnvelope> {
  if (!isInstallableUrl(url)) {
    throw new PluginError('E-NET-01', 'only https URLs (or loopback http) can be installed')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000)
  try {
    const response = await fetch(url, {
      signal: opts?.signal ?? controller.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new PluginError('E-NET-01', `fetch failed with HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > PACKAGE_LIMITS.maxBytes) {
      throw new PluginError('E-PKG-04', `package is ${declared} bytes (limit ${PACKAGE_LIMITS.maxBytes})`)
    }
    const text = await response.text()
    return parseEnvelope(text)
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('E-NET-01', 'failed to download plugin package', String(error))
  } finally {
    clearTimeout(timer)
  }
}
