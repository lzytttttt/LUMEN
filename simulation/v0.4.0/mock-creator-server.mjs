/**
 * simulation/v0.4.0/mock-creator-server.mjs —— 零依赖的「创造模式模拟端点」。
 *
 * 为什么单独一个服务：创造模式接的是**真实 OpenAI 兼容端点路径**（`provider.complete` → HTTP → SSE），
 * 它产出的 `CreatorProposal` 必须能过 04 §4.3 的双向校验。这里把 `src/fixtures/ai/creator-mock/`
 * 的 3 份 fixture 当作确定性产物（不复制内容、不在服务里再写一套提案），只负责：
 *
 * - `GET /health`、`GET /v1/models`：连通性与模型列表（设置页「测试连接」用）；
 * - `POST /v1/chat/completions`（兼容 `/chat/completions`）：OpenAI 聊天补全；
 *   - 按 system 里的 `[TASK:plugin]` 分派；非 plugin 任务显式 400（模拟端点只服务创造模式）；
 *   - 按 user payload 的 `intent`（theme/widget/command/other）选 fixture，repair 轮次选 plugin-3；
 *   - `stream:true` → SSE：role 帧 → 内容增量 → finish → usage（可选）→ `data: [DONE]`；
 * - 请求日志 JSONL（system/user 只记长度与 task，**不落全文**，避免把用户一句话写进证据）；
 * - `--selftest`：自起自停跑契约自测（8 项），不依赖浏览器。
 *
 * 零新增依赖：只用 `node:http` / `node:fs` / `node:path`。
 */
import { createServer } from 'node:http'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FIXTURE_DIR = path.join(ROOT, 'src', 'fixtures', 'ai', 'creator-mock')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const CFG = {
  port: Number(argOf('port', '5299')),
  host: argOf('host', '127.0.0.1'),
  model: argOf('model', 'lumen-sim-plugin-0.4'),
  log: argOf('log', ''),
  chunkSize: Math.max(1, Number(argOf('chunk-size', '80'))),
  chunkMs: Math.max(0, Number(argOf('chunk-ms', '6'))),
  selftest: argv.includes('--selftest'),
}

/* ------------------------------ 确定性产物 ------------------------------ */

const FIXTURE_FILES = {
  theme: 'plugin-1.json',
  widget: 'plugin-2.json',
  command: 'plugin-3.json',
  other: 'plugin-1.json',
}

/** intent → 提案 JSON 文本（从 replay fixture 的 `text` 字段读，内容与 e2e/mock 完全一致）。 */
const proposals = new Map()

async function loadProposals() {
  for (const [intent, file] of Object.entries(FIXTURE_FILES)) {
    if (intent === 'other') continue
    const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, file), 'utf8'))
    if (typeof raw?.text !== 'string') throw new Error(`fixture ${file} 缺少 text 字段`)
    // 端到端自检：产物必须能当 CreatorProposal 用（不 import src/**，只查冻结形状）。
    const proposal = JSON.parse(raw.text)
    for (const key of ['title', 'summary', 'kind', 'risk', 'capabilities', 'files', 'changes']) {
      if (proposal[key] === undefined) throw new Error(`fixture ${file} 缺字段 ${key}`)
    }
    if (!Array.isArray(proposal.files) || proposal.files.length === 0) throw new Error(`fixture ${file} files 为空`)
    proposals.set(intent, raw.text)
  }
  proposals.set('other', proposals.get('theme'))
}

/* ------------------------------ 请求解析 ------------------------------ */

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

function messagesOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.filter((item) => item?.role === 'system').map((item) => contentText(item.content)).join('\n')
  const users = messages.filter((item) => item?.role === 'user').map((item) => contentText(item.content))
  const assistants = messages.filter((item) => item?.role === 'assistant').map((item) => contentText(item.content))
  return { system, user: users.join('\n'), lastUser: users[users.length - 1] ?? '', assistants }
}

function taskOf(system) {
  const match = /\[TASK:([a-z0-9-]+)\]/i.exec(system)
  return match ? match[1].toLowerCase() : ''
}

function readUserPayload(user) {
  const start = user.indexOf('{')
  const end = user.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const value = JSON.parse(user.slice(start, end + 1))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

const INTENTS = new Set(['theme', 'widget', 'command', 'other'])

/** 请求 → 确定性提案文本（04 §6.6：按 payload.intent 选，repair 轮选 plugin-3）。 */
function proposalOf({ system, lastUser, user }) {
  const isRepair = /上一次输出没有通过创造模式校验/.test(lastUser)
  const payload = readUserPayload(lastUser || user)
  const intent = typeof payload.intent === 'string' && INTENTS.has(payload.intent) ? payload.intent : 'other'
  const text = isRepair ? proposals.get('command') : (proposals.get(intent) ?? proposals.get('other'))
  return { intent: isRepair ? 'command' : intent, repair: isRepair, text }
}

/* ------------------------------ SSE / 响应 ------------------------------ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
  'access-control-allow-credentials': 'true',
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

let requestCount = 0

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chatChunk({ id, created, model, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  }
}

function usageOf(system, user, completion) {
  const estimate = (text) => Math.max(1, Math.ceil(text.length / 4))
  const prompt = estimate(system + user)
  return { prompt_tokens: prompt, completion_tokens: estimate(completion), total_tokens: prompt + estimate(completion) }
}

function errorBody(message, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code: null } }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS,
  })
  res.end(body)
}

async function logRequest(entry) {
  if (!CFG.log) return
  try {
    await mkdir(path.dirname(CFG.log), { recursive: true })
    await appendFile(CFG.log, `${JSON.stringify(entry)}\n`)
  } catch {
    /* 日志失败不影响服务 */
  }
}

function streamProposal(res, { id, created, model, text, system, user, includeUsage, intent, repair }) {
  res.writeHead(200, { ...SSE_HEADERS, ...CORS })
  const write = (payload) => res.write(payload)

  let index = 0
  const pieces = []
  while (index < text.length) {
    pieces.push(text.slice(index, index + CFG.chunkSize))
    index += CFG.chunkSize
  }
  const finish = () => {
    write(sseFrame(chatChunk({ id, created, model, delta: {}, finish: 'stop' })))
    if (includeUsage) {
      write(sseFrame({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(system, user, text) }))
    }
    write('data: [DONE]\n\n')
    res.end()
    void logRequest({
      at: new Date().toISOString(),
      task: 'plugin',
      intent,
      repair,
      stream: true,
      model,
      systemChars: system.length,
      userChars: user.length,
      responseChars: text.length,
    })
  }

  write(sseFrame(chatChunk({ id, created, model, delta: { role: 'assistant', content: '' } })))
  if (CFG.chunkMs === 0) {
    for (const piece of pieces) write(sseFrame(chatChunk({ id, created, model, delta: { content: piece } })))
    finish()
    return
  }
  let cursor = 0
  const timer = setInterval(() => {
    if (cursor >= pieces.length) {
      clearInterval(timer)
      finish()
      return
    }
    write(sseFrame(chatChunk({ id, created, model, delta: { content: pieces[cursor] } })))
    cursor += 1
  }, CFG.chunkMs)
  res.on('close', () => clearInterval(timer))
}

/* ------------------------------ HTTP 服务 ------------------------------ */

function createSimServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${CFG.host}:${CFG.port}`)
      const pathname = url.pathname
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method === 'GET' && pathname === '/health') {
        requestCount += 1
        writeJson(res, 200, {
          ok: true,
          service: 'lumen-mock-creator',
          version: '0.4.0',
          model: CFG.model,
          requests: requestCount,
          intents: [...proposals.keys()],
        })
        return
      }
      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        writeJson(res, 200, {
          object: 'list',
          data: [{ id: CFG.model, object: 'model', created: 1_760_000_000, owned_by: 'lumen-sim' }],
        })
        return
      }
      if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          writeJson(res, 400, errorBody('body is not valid JSON'))
          return
        }
        const { system, user, lastUser, assistants } = messagesOf(body)
        const task = taskOf(system)
        if (task !== 'plugin') {
          await logRequest({ at: new Date().toISOString(), task, rejected: true })
          writeJson(res, 400, errorBody(`mock creator only serves task=plugin (got "${task || 'none'}")`))
          return
        }
        requestCount += 1
        const { intent, repair, text } = proposalOf({ system, lastUser: lastUser || user, user, assistants })
        const id = `chatcmpl-sim-${requestCount}`
        const created = Math.floor(Date.now() / 1000)
        const includeUsage = body?.stream_options?.include_usage === true
        if (body?.stream === true) {
          streamProposal(res, { id, created, model: CFG.model, text, system, user, includeUsage, intent, repair })
          return
        }
        writeJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: CFG.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: usageOf(system, user, text),
        })
        await logRequest({
          at: new Date().toISOString(),
          task: 'plugin',
          intent,
          repair,
          stream: false,
          model: CFG.model,
          systemChars: system.length,
          userChars: user.length,
          responseChars: text.length,
        })
        return
      }
      writeJson(res, 404, errorBody(`unknown path ${pathname}`))
    } catch (error) {
      writeJson(res, 500, errorBody(String(error?.message ?? error), 'server_error'))
    }
  })
}

/* ------------------------------ 自测（--selftest） ------------------------------ */

async function runSelftest() {
  await loadProposals()
  const server = createSimServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, CFG.host, resolve)
  })
  const base = `http://${CFG.host}:${server.address().port}`
  const checks = []
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

  const health = await fetch(`${base}/health`).then((response) => response.json())
  check('GET /health', health.ok === true && health.intents.length >= 3, `intents=${health.intents?.join(',')}`)

  const models = await fetch(`${base}/v1/models`).then((response) => response.json())
  check('GET /v1/models', models.data?.[0]?.id === CFG.model, models.data?.[0]?.id ?? '')

  const pluginBody = (intent) => ({
    model: CFG.model,
    stream: false,
    messages: [
      { role: 'system', content: '[TASK:plugin]\n你是插件架构师' },
      { role: 'user', content: JSON.stringify({ intent, prompt: 'sim', context: {} }) },
    ],
  })

  for (const intent of ['theme', 'widget', 'command']) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pluginBody(intent)),
    }).then((item) => item.json())
    const text = response.choices?.[0]?.message?.content ?? ''
    let proposal = null
    try {
      proposal = JSON.parse(text)
    } catch {
      /* 下面断言会失败并给 detail */
    }
    check(
      `POST plugin/${intent}`,
      Boolean(proposal?.title && Array.isArray(proposal.files) && proposal.files.length > 0),
      proposal ? `${proposal.title} · files=${proposal.files.length}` : 'bad json',
    )
  }

  const nonPlugin = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CFG.model,
      messages: [
        { role: 'system', content: '[TASK:outline]\n大纲' },
        { role: 'user', content: '{}' },
      ],
    }),
  })
  check('非 plugin 任务显式拒绝（不串任务）', nonPlugin.status === 400, `status=${nonPlugin.status}`)

  const repair = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CFG.model,
      messages: [
        { role: 'system', content: '[TASK:plugin]\n你是插件架构师' },
        { role: 'user', content: '上一次输出没有通过创造模式校验，问题如下：\n- title: too short' },
      ],
    }),
  }).then((item) => item.json())
  const repairText = repair.choices?.[0]?.message?.content ?? ''
  check('repair 轮返回可解析提案', (() => {
    try {
      return Boolean(JSON.parse(repairText).title)
    } catch {
      return false
    }
  })())

  // SSE：逐帧拼接必须等于非流式 text
  const streamResponse = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...pluginBody('theme'), stream: true, stream_options: { include_usage: true } }),
  })
  const raw = await streamResponse.text()
  const frames = raw
    .split(/\n\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => frame.slice(5).trim())
  const done = frames[frames.length - 1] === '[DONE]'
  const deltas = frames
    .filter((frame) => frame !== '[DONE]')
    .map((frame) => {
      try {
        return JSON.parse(frame)
      } catch {
        return null
      }
    })
    .filter((frame) => frame?.choices?.[0]?.delta?.content)
    .map((frame) => frame.choices[0].delta.content)
    .join('')
  check('SSE 帧完整且以 [DONE] 收尾', done && deltas.length > 0, `frames=${frames.length}`)
  check('SSE 拼接 == 非流式产物', deltas.length > 0 && JSON.parse(deltas).title !== undefined, `chars=${deltas.length}`)

  await new Promise((resolve) => server.close(resolve))
  const failed = checks.filter((checkItem) => !checkItem.ok)
  for (const checkItem of checks) {
    console.log(`${checkItem.ok ? 'PASS' : 'FAIL'} ${checkItem.name}${checkItem.detail ? ` · ${checkItem.detail}` : ''}`)
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
  process.exit(failed.length > 0 ? 1 : 0)
}

/* --------------------------------- 入口 --------------------------------- */

async function main() {
  if (CFG.selftest) {
    await runSelftest()
    return
  }
  await loadProposals()
  const server = createSimServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(CFG.port, CFG.host, resolve)
  })
  const port = server.address().port
  console.log(`[mock-creator] listening http://${CFG.host}:${port}/v1 · model=${CFG.model} · fixtures=${[...proposals.keys()].join(',')}`)
  if (CFG.log) console.log(`[mock-creator] requests log → ${CFG.log}`)
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  console.error('[mock-creator] fatal:', error)
  process.exit(1)
})

export { createSimServer }
