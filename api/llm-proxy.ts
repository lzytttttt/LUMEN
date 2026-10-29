/**
 * api/llm-proxy.ts —— 可选的 Edge 转发模板，解决"浏览器直连第三方 LLM 被 CORS 拦"的问题。
 *
 * 设计原则（与 README 的隐私承诺一致）：
 * - **无状态**：不写日志、不落盘、不缓存请求/响应体；只做一次转发。
 * - **默认拒绝**：只允许 `LUMEN_PROXY_ALLOWLIST` 里的主机（逗号分隔），防止部署后被当成
 *   公开代理薅流量。需要接自建网关时，在 Vercel → Settings → Environment Variables 里加域名。
 * - **不转发浏览器指纹**：Cookie / Origin / Referer / Host 一律丢弃；Authorization 与
 *   Content-Type、Accept、OpenAI 兼容头显式放行。
 * - **流式**：直接透传 `ReadableStream`，SSE 增量不被缓冲。
 *
 * 使用方式：
 *   1. 部署到 Vercel（`api/` 目录会被自动识别为 Edge Function）；
 *   2. 应用里把 baseURL 设为 `https://<你的域名>/api/llm-proxy`；
 *   3. 请求头带 `x-lumen-upstream: https://api.deepseek.com/v1/chat/completions`；
 *   4. 其余请求体/鉴权头保持原样，代理只换目标地址。
 *
 * 本地 `vercel dev` 亦可调试；纯静态部署不使用该函数时，它不会影响任何现有路径。
 */

export const config = { runtime: 'edge' }

/** 默认放行的 OpenAI 兼容端点（按需在环境变量里追加）。 */
const DEFAULT_ALLOWLIST = [
  'api.openai.com',
  'api.deepseek.com',
  'openrouter.ai',
  'api.moonshot.cn',
  'api.siliconflow.cn',
  'dashscope.aliyuncs.com',
  'api.groq.com',
  'api.mistral.ai',
  'generativelanguage.googleapis.com',
]

/** 明确不转发给上游的请求头。 */
const STRIP_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'x-lumen-upstream',
])

/** 允许转发给上游的请求头（其余一律丢弃，避免把浏览器指纹带出去）。 */
const FORWARD_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'accept-encoding',
  'user-agent',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
])

function allowlist(): string[] {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const extra = (raw?.LUMEN_PROXY_ALLOWLIST ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return [...DEFAULT_ALLOWLIST, ...extra]
}

function allowedOrigins(): string[] {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return (raw?.LUMEN_PROXY_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  const allow = allowedOrigins()
  const allowed = allow.length === 0 || allow.includes('*') || (origin !== '' && allow.includes(origin))
  return {
    // 未配置 LUMEN_PROXY_ORIGINS 时默认 *：代理本身无凭据状态，鉴权头由调用方自带。
    'Access-Control-Allow-Origin': allowed ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, content-type, accept, x-lumen-upstream, openai-beta, openai-organization, openai-project, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  })
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (/^127\./.test(host) || host === '::1' || host === '0.0.0.0') return true
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  return false
}

/** 校验并归一化上游地址；不合法返回 null。 */
function resolveUpstream(raw: string | null, options: { allowlist: string[] }): URL | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (isPrivateHost(url.hostname)) return null
  const host = url.hostname.toLowerCase()
  const allowed = options.allowlist.some((entry) => {
    if (entry === '*') return true
    return host === entry || host.endsWith(`.${entry}`)
  })
  return allowed ? url : null
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }

  const url = new URL(request.url)
  if (request.method === 'GET') {
    // 健康检查：不暴露 allowlist 细节，只回答"函数在"。
    return json({ ok: true, service: 'lumen-llm-proxy', methods: ['POST', 'OPTIONS'] }, 200, request)
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, request)
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) {
    return json({ error: 'payload_too_large' }, 413, request)
  }

  const upstream = resolveUpstream(
    request.headers.get('x-lumen-upstream') ?? url.searchParams.get('url'),
    { allowlist: allowlist() },
  )
  if (!upstream) {
    return json(
      {
        error: 'upstream_not_allowed',
        hint: 'Set x-lumen-upstream to an allowlisted https endpoint, or add the host to LUMEN_PROXY_ALLOWLIST.',
      },
      403,
      request,
    )
  }

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (STRIP_HEADERS.has(lower)) return
    if (!FORWARD_HEADERS.has(lower) && !lower.startsWith('x-')) return
    headers.set(key, value)
  })
  // 不跟随重定向：避免代理被 3xx 带到未授权主机。
  headers.set('accept-encoding', 'identity')

  let body: ArrayBuffer | undefined
  try {
    body = await request.arrayBuffer()
  } catch {
    return json({ error: 'body_read_failed' }, 400, request)
  }

  try {
    const response = await fetch(upstream, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(180_000),
    })
    const out = new Headers(corsHeaders(request))
    const type = response.headers.get('content-type')
    if (type) out.set('content-type', type)
    out.set('cache-control', 'no-store')
    // 透传上游的重要头（限流/请求 id），便于客户端排障。
    for (const key of ['retry-after', 'x-request-id', 'openai-processing-ms']) {
      const value = response.headers.get(key)
      if (value) out.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers: out })
  } catch (error) {
    return json(
      { error: 'upstream_unreachable', detail: error instanceof Error ? error.message : String(error) },
      502,
      request,
    )
  }
}
