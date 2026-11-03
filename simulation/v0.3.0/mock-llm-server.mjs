#!/usr/bin/env node
/**
 * mock-llm-server.mjs —— LUMEN v0.3.0「LLM 实战模拟」的本地模拟模型服务。
 *
 * 目标：在完全不联网、不依赖任何第三方包的前提下，给 LUMEN 的 AI 链路
 * （outline → slide → svg/three → refine）提供一个 OpenAI 兼容端点，
 * 让「真端点」这条代码路径能被完整演练：请求体、SSE 逐帧流式、
 * response_format、usage、429 退避、截断 JSON 修复、断流回退全部可复现。
 *
 * 契约（与 src/ai/provider.ts 对齐）：
 * - POST /v1/chat/completions（同时兼容 /chat/completions）：
 *   body { model, messages, temperature, stream, stream_options, response_format }
 *   从 system（messages[0].content）用 /\[TASK:([a-z0-9-]+)\]/i 取 task；
 *   从 user（messages[1].content）取第一个 { 到最后一个 } 作为 JSON payload。
 * - stream:true → SSE：role 帧 → 正文增量帧（默认 18 字 / 16ms）→ finish_reason:'stop'
 *   →（include_usage 时）usage 帧 → data: [DONE]。
 * - stream:false → OpenAI chat.completion JSON（含 usage）。
 * - 模型名开关（鲁棒性演练用）：
 *   'lumen-sim-badjson'   前 2 次返回可被 closeTruncatedJson 修复的截断 JSON；
 *   'lumen-sim-429'       前 2 次返回 429 + retry-after: 0；
 *   'lumen-sim-streambreak' stream 请求只写 role 帧、0 个正文 delta 就断开
 *                        （触发 LUMEN §4.6「0 delta → 非流式回退」那条路径）。
 * - 每个推理请求（含失败/重试）追加一行 JSONL 到 --log（默认 results/llm/requests.jsonl）。
 *
 * 用法：
 *   node simulation/v0.3.0/mock-llm-server.mjs
 *   node simulation/v0.3.0/mock-llm-server.mjs --port 5299 --chunk-ms 16 --chunk-size 18
 *   node simulation/v0.3.0/mock-llm-server.mjs --selftest
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  outline as scenarioOutline,
  slide as scenarioSlide,
  svg as scenarioSvg,
  three as scenarioThree,
  refine as scenarioRefine,
} from './scenarios.mjs'

/* ========================================================================== */
/*                                  常量                                       */
/* ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOG = path.join(HERE, 'results', 'llm', 'requests.jsonl')
const DEFAULT_PORT = 5299
const DEFAULT_CHUNK_MS = 16
const DEFAULT_CHUNK_SIZE = 18
const MAX_BODY_BYTES = 4 * 1024 * 1024
const RESPONSE_TEXT_LIMIT = 4000

const BASE_MODEL = 'lumen-sim-0.3'
const SWITCH_MODELS = ['lumen-sim-badjson', 'lumen-sim-429', 'lumen-sim-streambreak']
const ALL_MODELS = [BASE_MODEL, ...SWITCH_MODELS]

/** 任务 → 场景生成器（system 里的 [TASK:x] 决定走哪个）。 */
const SCENARIO_FNS = {
  outline: scenarioOutline,
  slide: scenarioSlide,
  svg: scenarioSvg,
  three: scenarioThree,
  refine: scenarioRefine,
}

/** 所有响应都带 CORS：浏览器里的 LUMEN 直接配 http://127.0.0.1:5299/v1 就能用。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
  // 429 演练要用：跨域下 Retry-After 默认不可被 JS 读取，必须显式暴露。
  'access-control-expose-headers': 'retry-after',
}

const SSE_HEADERS = {
  ...CORS_HEADERS,
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/* ========================================================================== */
/*                                 工具                                        */
/* ========================================================================== */

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 打印用：把任意文本压成一行并截到 n 个字符。 */
function snippet(value, max = 200) {
  const chars = Array.from(oneLine(value))
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, max).join('')}…`
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

function taskOf(system) {
  const match = /\[TASK:([a-z0-9-]+)\]/i.exec(String(system ?? ''))
  return match ? match[1].toLowerCase() : ''
}

/** 从 user 消息里读出 JSON payload（与 provider.ts 的 readPayload 同一把尺子）。 */
function readPayload(user) {
  const text = String(user ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 3))
}

function usageOf(system, user, completion) {
  const prompt = estimateTokens(`${system}${user}`)
  const completionTokens = estimateTokens(completion)
  return {
    prompt_tokens: prompt,
    completion_tokens: completionTokens,
    total_tokens: prompt + completionTokens,
  }
}

function errorBody(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, param: null, code } }
}

/**
 * 把合法 JSON 文本截断成一个「closeTruncatedJson 能修回来」的半截对象。
 *
 * 做法：找到最后一个字符串字段（outline 的 notes / slide 的 notes / svg 的 caption），
 * 从它的值中间切断。closeTruncatedJson 会补上引号与括号，得到的 JSON 语法合法、
 * schema 也依然成立（只丢几个字），于是 LUMEN 的修复环能真正跑通。
 * 找不到安全切点时返回 null（表示这次不截断）。
 */
function truncateRepairable(text) {
  const source = String(text ?? '')
  if (!source.startsWith('{')) return null
  const marker = source.lastIndexOf('":"')
  if (marker < 0) return null
  const valueStart = marker + 3
  const valueEnd = source.indexOf('"', valueStart)
  if (valueEnd < 0) return null
  // 值之后只允许出现闭合括号与空白，才说明它是「最后一个字符串字段」。
  if (!/^[\s\]}]*$/.test(source.slice(valueEnd + 1))) return null
  const valueLength = valueEnd - valueStart
  if (valueLength < 10) return null
  return source.slice(0, valueStart + 6)
}

function ensureLogDir(logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true })
}

/* ========================================================================== */
/*                                 参数                                        */
/* ========================================================================== */

function parseArgs(argv) {
  const config = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    log: DEFAULT_LOG,
    chunkMs: DEFAULT_CHUNK_MS,
    chunkSize: DEFAULT_CHUNK_SIZE,
    selftest: false,
    quiet: false,
    badjsonTimes: 2,
    rateLimitTimes: 2,
    help: false,
  }
  const warnings = []

  const takeValue = (index, inline, name) => {
    if (inline !== null) return { value: inline, next: index }
    if (index + 1 >= argv.length) {
      warnings.push(`--${name} 缺少取值，忽略`)
      return { value: null, next: index }
    }
    return { value: argv[index + 1], next: index + 1 }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--selftest') {
      config.selftest = true
      continue
    }
    if (arg === '--quiet') {
      config.quiet = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      config.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      warnings.push(`未知参数 ${arg}，忽略`)
      continue
    }
    const equalAt = arg.indexOf('=')
    const name = equalAt >= 0 ? arg.slice(2, equalAt) : arg.slice(2)
    const inline = equalAt >= 0 ? arg.slice(equalAt + 1) : null
    const taken = takeValue(index, inline, name)
    index = taken.next
    if (taken.value === null) continue
    const numeric = Number(taken.value)
    switch (name) {
      case 'port':
        if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) warnings.push(`--port 取值非法：${taken.value}`)
        else config.port = numeric
        break
      case 'host':
        if (taken.value.trim() !== '') config.host = taken.value.trim()
        break
      case 'log':
        if (taken.value.trim() !== '') config.log = path.resolve(taken.value.trim())
        break
      case 'chunk-ms':
        if (!Number.isFinite(numeric) || numeric < 0) warnings.push(`--chunk-ms 取值非法：${taken.value}`)
        else config.chunkMs = Math.min(2000, Math.round(numeric))
        break
      case 'chunk-size':
        if (!Number.isFinite(numeric) || numeric < 1) warnings.push(`--chunk-size 取值非法：${taken.value}`)
        else config.chunkSize = Math.min(4000, Math.round(numeric))
        break
      case 'badjson-times':
        if (!Number.isFinite(numeric) || numeric < 0) warnings.push(`--badjson-times 取值非法：${taken.value}`)
        else config.badjsonTimes = Math.round(numeric)
        break
      case 'rate-limit-times':
        if (!Number.isFinite(numeric) || numeric < 0) warnings.push(`--rate-limit-times 取值非法：${taken.value}`)
        else config.rateLimitTimes = Math.round(numeric)
        break
      default:
        warnings.push(`未知参数 --${name}，忽略`)
    }
  }
  return { config, warnings }
}

function usageText() {
  return `[sim-llm] 用法：node simulation/v0.3.0/mock-llm-server.mjs [选项]
  --port <n>             监听端口（默认 ${DEFAULT_PORT}，0 = 随机可用端口）
  --log <path>           JSONL 请求日志（默认 simulation/v0.3.0/results/llm/requests.jsonl）
  --chunk-ms <n>         SSE 每帧间隔毫秒（默认 ${DEFAULT_CHUNK_MS}）
  --chunk-size <n>       SSE 每帧字符数（默认 ${DEFAULT_CHUNK_SIZE}）
  --badjson-times <n>    badjson 开关截断次数（默认 2）
  --rate-limit-times <n> 429 开关限流次数（默认 2）
  --selftest             自测：起服务 → 打一遍全部契约 → PASS/FAIL 汇总
  --quiet                不打印请求摘要
  --help                 显示本帮助`
}

/* ========================================================================== */
/*                                 服务                                        */
/* ========================================================================== */

/**
 * 创建一个模拟服务实例（不 listen）。
 * @param {ReturnType<typeof parseArgs>['config']} config
 */
function createSimServer(config) {
  const state = {
    startedAt: Date.now(),
    requests: 0,
    /** 每个模型名各自的开关计数（badjson / 429 用）。 */
    calls: new Map(),
    inFlight: 0,
  }

  ensureLogDir(config.log)
  const logPath = config.log

  function bump(model) {
    const next = (state.calls.get(model) ?? 0) + 1
    state.calls.set(model, next)
    return next
  }

  function appendLog(entry) {
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    }
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      if (!config.quiet) console.error(`[sim-llm] 日志写入失败：${error.message}`)
    }
    return record
  }

  function logChat(fields) {
    return appendLog({
      id: fields.id,
      model: fields.model,
      task: fields.task,
      stream: fields.stream === true,
      status: fields.status,
      ms: fields.ms,
      promptChars: fields.promptChars,
      completionChars: fields.completionChars,
      responseText: String(fields.responseText ?? '').slice(0, RESPONSE_TEXT_LIMIT),
      request: {
        system: String(fields.system ?? ''),
        user: String(fields.user ?? ''),
      },
      ...(fields.extra ?? {}),
    })
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    })
    res.end(body)
  }

  function modelsPayload() {
    const created = Math.floor(state.startedAt / 1000)
    return {
      object: 'list',
      data: ALL_MODELS.map((id) => ({ id, object: 'model', created, owned_by: 'lumen-sim' })),
    }
  }

  function healthPayload() {
    return {
      ok: true,
      model: BASE_MODEL,
      requests: state.requests,
      models: ALL_MODELS,
      log: logPath,
      uptimeMs: Date.now() - state.startedAt,
      stream: { chunkSize: config.chunkSize, chunkMs: config.chunkMs },
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体超过 4MB'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', (error) => reject(error))
    })
  }

  /* ------------------------------ SSE 流式 ------------------------------ */

  const chatChunk = (id, created, model, delta, finishReason) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })

  function sseFrame(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  /**
   * 写一条 SSE 流。所有定时器集中在 timers 里；客户端断开时统一清理，
   * 并回调 onAbort（用于日志）。
   *
   * `breakBeforeDelta: true` 是 streambreak 开关的行为：role 帧之后一个正文 delta
   * 都不发，直接 destroy 连接 —— 于是 LUMEN 的 provider 收到 0 delta + 断流，
   * 命中 §4.6 的非流式回退（received.deltas === 0 才回退）。
   */
  function streamChat(res, options) {
    const { id, created, model, text, includeUsage, usage, breakBeforeDelta = false } = options
    const chars = Array.from(text)
    const timers = new Set()
    let closed = false
    let finished = false
    let timer = null
    let cursor = 0
    let deltaCount = 0
    let sentText = ''

    const cleanup = () => {
      for (const handle of timers) clearTimeout(handle)
      timers.clear()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const onClose = () => {
      if (closed || finished) return
      closed = true
      cleanup()
      options.onAbort?.(sentText, deltaCount)
    }
    res.on('close', onClose)
    res.on('error', onClose)

    const write = (frame) => {
      if (closed || finished || res.writableEnded || res.destroyed) return false
      try {
        return res.write(frame)
      } catch {
        closed = true
        cleanup()
        return false
      }
    }

    /** 收尾帧专用：finish() 会先置 finished 再写，所以这里不看 finished。 */
    const rawWrite = (frame) => {
      if (closed || res.writableEnded || res.destroyed) return false
      try {
        return res.write(frame)
      } catch {
        closed = true
        cleanup()
        return false
      }
    }

    const schedule = (fn, delay) => {
      const handle = setTimeout(() => {
        timers.delete(handle)
        fn()
      }, Math.max(0, delay))
      timers.add(handle)
      return handle
    }

    const finish = () => {
      if (finished || closed) return
      finished = true
      cleanup()
      rawWrite(sseFrame(chatChunk(id, created, model, {}, 'stop')))
      if (includeUsage) {
        rawWrite(sseFrame({ id, object: 'chat.completion.chunk', created, model, choices: [], usage }))
      }
      rawWrite('data: [DONE]\n\n')
      if (!res.writableEnded && !res.destroyed) res.end()
      options.onDone?.(sentText, deltaCount)
    }

    const step = () => {
      timer = null
      if (closed || finished) return
      if (cursor >= chars.length) {
        finish()
        return
      }
      const piece = chars.slice(cursor, cursor + config.chunkSize).join('')
      cursor += config.chunkSize
      deltaCount += 1
      sentText += piece
      if (!write(sseFrame(chatChunk(id, created, model, { content: piece })))) {
        closed = true
        cleanup()
        options.onAbort?.(sentText, deltaCount)
        return
      }
      timer = schedule(step, config.chunkMs)
    }

    res.writeHead(200, SSE_HEADERS)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    write(sseFrame(chatChunk(id, created, model, { role: 'assistant' }, null)))
    if (breakBeforeDelta) {
      // 断流演练：role 帧先 flush，然后一个正文 delta 都不发就 destroy。
      schedule(() => {
        if (closed || finished) return
        finished = true
        cleanup()
        if (!res.destroyed) res.destroy()
        options.onBreak?.('', 0)
      }, config.chunkMs)
      return
    }
    if (chars.length === 0) {
      finish()
      return
    }
    timer = schedule(step, config.chunkMs)
  }

  /* --------------------------- chat/completions --------------------------- */

  async function handleChat(req, res) {
    const startedAt = Date.now()
    state.requests += 1
    state.inFlight += 1
    const requestNo = state.requests
    const id = `chatcmpl-sim-${requestNo.toString(36)}-${Date.now().toString(36)}`
    const created = Math.floor(Date.now() / 1000)

    let bodyText = ''
    let body = null
    let parseError = null
    let system = ''
    let user = ''
    let task = ''
    let stream = false
    let model = BASE_MODEL

    try {
      bodyText = await readBody(req)
      try {
        body = bodyText.trim() === '' ? null : JSON.parse(bodyText)
      } catch (error) {
        parseError = error
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        if (typeof body.model === 'string' && body.model.trim() !== '') model = body.model.trim()
        stream = body.stream === true
        const messages = Array.isArray(body.messages) ? body.messages : []
        const systemMessage = messages.find((message) => message && message.role === 'system') ?? messages[0]
        const userMessage = messages.find((message) => message && message.role === 'user') ?? messages[1]
        system = contentText(systemMessage?.content)
        user = contentText(userMessage?.content)
        task = taskOf(system)
      }

      /* ---------------------------- 400：坏请求 ---------------------------- */
      if (parseError || !body || typeof body !== 'object' || Array.isArray(body)) {
        const payload = errorBody(
          parseError ? `sim: 请求体不是合法 JSON（${parseError.message}）` : 'sim: 请求体必须是 JSON 对象',
          'invalid_request_error',
          'bad_request',
        )
        const responseText = JSON.stringify(payload)
        logChat({
          id,
          model,
          task,
          stream,
          status: 400,
          ms: Date.now() - startedAt,
          promptChars: system.length + user.length,
          completionChars: 0,
          responseText,
          system,
          user,
          extra: { error: 'bad_request', path: '/v1/chat/completions', requestBytes: bodyText.length },
        })
        sendJson(res, 400, payload)
        return
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        const payload = errorBody('sim: messages 不能为空', 'invalid_request_error', 'bad_request')
        logChat({
          id,
          model,
          task,
          stream,
          status: 400,
          ms: Date.now() - startedAt,
          promptChars: system.length + user.length,
          completionChars: 0,
          responseText: JSON.stringify(payload),
          system,
          user,
          extra: { error: 'missing_messages', path: '/v1/chat/completions' },
        })
        sendJson(res, 400, payload)
        return
      }

      const promptChars = system.length + user.length

      /* ------------------------- 429 限流演练开关 ------------------------- */
      if (model.includes('429')) {
        const attempt = bump(model)
        if (attempt <= config.rateLimitTimes) {
          const payload = {
            error: {
              message: `sim: 命中模型开关 ${model} 的第 ${attempt} 次限流（retry-after: 0）`,
              type: 'rate_limit_error',
              param: null,
              code: 'rate_limit_exceeded',
            },
          }
          const responseText = JSON.stringify(payload)
          logChat({
            id,
            model,
            task,
            stream,
            status: 429,
            ms: Date.now() - startedAt,
            promptChars,
            completionChars: 0,
            responseText,
            system,
            user,
            extra: { error: 'rate_limit', attempt, retryAfter: '0' },
          })
          sendJson(res, 429, payload, { 'retry-after': '0' })
          return
        }
      }

      /* ---------------------------- 生成内容 ---------------------------- */
      const fn = SCENARIO_FNS[task]
      const payloadIn = readPayload(user)
      let text
      try {
        text = fn ? JSON.stringify(fn(payloadIn)) : JSON.stringify({ text: `sim: 未知任务标记 "${task}"`, task })
      } catch (error) {
        const failure = errorBody(`sim: 场景生成失败（${error.message}）`, 'server_error', 'scenario_failed')
        const responseText = JSON.stringify(failure)
        logChat({
          id,
          model,
          task,
          stream,
          status: 500,
          ms: Date.now() - startedAt,
          promptChars,
          completionChars: 0,
          responseText,
          system,
          user,
          extra: { error: 'scenario_failed' },
        })
        sendJson(res, 500, failure)
        return
      }

      /* ---------------------- badjson 截断演练开关 ---------------------- */
      let truncated = false
      if (model.includes('badjson')) {
        const attempt = bump(model)
        if (attempt <= config.badjsonTimes) {
          const broken = truncateRepairable(text)
          if (broken !== null) {
            text = broken
            truncated = true
          }
        }
      }

      /* ---------------------- streambreak 断流演练开关 ---------------------- */
      const wantBreak = model.includes('streambreak') && stream
      const usage = usageOf(system, user, text)
      const responseText = text

      if (stream) {
        streamChat(res, {
          id,
          created,
          model,
          text,
          includeUsage: body.stream_options?.include_usage === true,
          usage,
          breakBeforeDelta: wantBreak,
          onDone: (sent, deltas) => {
            state.inFlight = Math.max(0, state.inFlight - 1)
            logChat({
              id,
              model,
              task,
              stream: true,
              status: 200,
              ms: Date.now() - startedAt,
              promptChars,
              completionChars: sent.length,
              responseText: sent,
              system,
              user,
              extra: {
                path: '/v1/chat/completions',
                deltas,
                truncated,
                finishReason: 'stop',
                usage,
              },
            })
            if (!config.quiet) {
              console.log(
                `[sim-llm] 200 stream ${model} ${task || '-'} ${sent.length}字 ${Date.now() - startedAt}ms → ${snippet(sent, 60)}`,
              )
            }
          },
          onAbort: (sent, deltas) => {
            state.inFlight = Math.max(0, state.inFlight - 1)
            logChat({
              id,
              model,
              task,
              stream: true,
              status: 200,
              ms: Date.now() - startedAt,
              promptChars,
              completionChars: sent.length,
              responseText: sent,
              system,
              user,
              extra: { path: '/v1/chat/completions', deltas, truncated, aborted: true, clientClosed: true },
            })
            if (!config.quiet) {
              console.warn(`[sim-llm] stream 中断（客户端断开）${model} ${task || '-'} ${sent.length}字`)
            }
          },
          onBreak: (sent, deltas) => {
            state.inFlight = Math.max(0, state.inFlight - 1)
            logChat({
              id,
              model,
              task,
              stream: true,
              status: 200,
              ms: Date.now() - startedAt,
              promptChars,
              completionChars: sent.length,
              responseText: sent,
              system,
              user,
              extra: {
                path: '/v1/chat/completions',
                deltas,
                truncated,
                aborted: true,
                streamBreak: true,
                note: '模型开关：role 帧后 0 delta 直接断开（无 finish_reason / [DONE]）',
              },
            })
            if (!config.quiet) {
              console.warn(`[sim-llm] streambreak ${model} 已断开（0 个 delta，无 [DONE]）`)
            }
          },
        })
        return
      }

      state.inFlight = Math.max(0, state.inFlight - 1)
      const completion = {
        id,
        object: 'chat.completion',
        created,
        model,
        system_fingerprint: 'lumen-sim',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage,
      }
      logChat({
        id,
        model,
        task,
        stream: false,
        status: 200,
        ms: Date.now() - startedAt,
        promptChars,
        completionChars: text.length,
        responseText,
        system,
        user,
        extra: { path: '/v1/chat/completions', truncated, usage },
      })
      if (!config.quiet) {
        console.log(
          `[sim-llm] 200 json   ${model} ${task || '-'} ${text.length}字 ${Date.now() - startedAt}ms → ${snippet(text, 60)}`,
        )
      }
      sendJson(res, 200, completion)
    } catch (error) {
      state.inFlight = Math.max(0, state.inFlight - 1)
      if (res.writableEnded || res.destroyed) return
      const payload = errorBody(`sim: 服务内部错误（${error.message}）`, 'server_error', 'internal_error')
      logChat({
        id,
        model,
        task,
        stream,
        status: 500,
        ms: Date.now() - startedAt,
        promptChars: system.length + user.length,
        completionChars: 0,
        responseText: JSON.stringify(payload),
        system,
        user,
        extra: { error: 'internal_error' },
      })
      sendJson(res, 500, payload)
    }
  }

  /* ------------------------------ 路由 ------------------------------ */

  async function handleRequest(req, res) {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      pathname = '/'
    }
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)

    // 预检：任何路径都回 204 + CORS。
    if (req.method === 'OPTIONS') {
      if (!res.writableEnded) {
        res.writeHead(204, CORS_HEADERS)
        res.end()
      }
      return
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, healthPayload())
      return
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      sendJson(res, 200, modelsPayload())
      return
    }
    if (req.method === 'GET' && pathname === '/') {
      sendJson(res, 200, {
        name: 'lumen-sim-llm',
        version: '0.3.0',
        model: BASE_MODEL,
        models: ALL_MODELS,
        endpoints: ['GET /health', 'GET /v1/models', 'POST /v1/chat/completions', 'POST /chat/completions'],
      })
      return
    }
    if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') {
      if (req.method !== 'POST') {
        sendJson(res, 405, errorBody('sim: 该端点只接受 POST', 'invalid_request_error', 'method_not_allowed'), {
          allow: 'POST, OPTIONS',
        })
        return
      }
      await handleChat(req, res)
      return
    }

    sendJson(res, 404, errorBody(`sim: 没有这个端点 ${pathname}`, 'invalid_request_error', 'not_found'))
  }

  const server = createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch((error) => {
      if (res.writableEnded || res.destroyed) return
      sendJson(res, 500, errorBody(`sim: 未捕获错误（${error.message}）`, 'server_error', 'internal_error'))
    })
  })

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(server.address())
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(config.port, config.host)
    })
  }

  function close() {
    return new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  return { server, state, config, logPath, listen, close, port: () => server.address()?.port ?? config.port }
}

/* ========================================================================== */
/*                                  自测                                       */
/* ========================================================================== */

const RECIPES = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'data',
  'process',
  'gallery',
  'closing',
]
const THREE_PRESETS = ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe']
const THREE_SHAPES = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa']
const THREE_MATERIALS = ['standard', 'physical', 'toon', 'wireframe']
const THREE_TINTS = ['accent', 'accent2', 'fg', 'muted', 'surface']
const SVG_ALLOWED_TAGS = [
  'svg',
  'g',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'rect',
  'circle',
  'ellipse',
  'line',
  'path',
  'polyline',
  'polygon',
  'clipPath',
  'mask',
  'marker',
  'use',
  'title',
  'desc',
]
const SVG_ALLOWED_COLORS = new Set([
  'none',
  'currentColor',
  'var(--d-accent)',
  'var(--d-accent2)',
  'var(--d-line)',
  'var(--d-muted)',
  'var(--d-fg)',
  'var(--d-surface)',
])

/** 与 src/ai/prompts.ts 同构的「精简版」system prompt（首行保留 [TASK:x] 分派标记）。 */
const SELFTEST_SYSTEM = {
  outline: `[TASK:outline]
你是 LUMEN（幕光）的 AI 编排器。只输出 JSON，不写 CSS / JS / HTML 片段，不使用外链。
输出契约：
{"title":"演示标题，≤24 字","subtitle":"一行副标题","lang":"zh | en","slides":[{"recipe":"见配方表","headline":"≤24 字，有观点","lead":"≤40 字","points":["3–5 条，每条 ≤40 字"],"visual":{"kind":"svg","brief":"≤60 字"}|{"kind":"three","preset":"orbit|showcase|wave-field|particle-cloud|torus|stack|globe"}|{"kind":"none"},"notes":"讲者备注，≤60 字"}]}
结构要求：首幕必须是 cover，末幕必须是 closing；全篇最多 1 个 svg 幕与 1 个 three 幕。
data 用「标签=数值」、timeline 用「时间｜标题｜说明」、process 用「步骤｜时长｜说明」、compare 用「组名｜一句话」。`,
  slide: `[TASK:slide]
你是 LUMEN（幕光）的 AI 编排器。只输出 JSON，不写解释文字。
输出契约：{"headline":"≤24 字，有观点","lead":"≤40 字","points":["3–5 条，每条 ≤40 字"],"notes":"≤60 字，写怎么讲"}
要点遵守该幕 recipe 的分隔符：data「标签=数值」、timeline「时间｜标题｜说明」、process「步骤｜时长｜说明」、compare「组名｜一句话」。`,
  svg: `[TASK:svg]
你是 LUMEN（幕光）的 AI 编排器。只输出 JSON。
输出契约：{"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 820 560\\" fill=\\"none\\">…</svg>","viewBox":[0,0,820,560],"caption":"≤30 字"}
只允许标签 svg/g/defs/linearGradient/radialGradient/stop/rect/circle/ellipse/line/path/polyline/polygon/clipPath/mask/marker/use/title/desc；
颜色只用 var(--d-accent) 等主题令牌；不写 style 属性、不写 <text>、不写滤镜、不用外链。`,
  three: `[TASK:three]
你是 LUMEN（幕光）的 AI 编排器。只输出 JSON。
输出契约：{"descriptor":{"preset":"orbit|showcase|wave-field|particle-cloud|torus|stack|globe","palette":"accent|mono|duotone","light":"studio|sunset|neon|soft","bg":"transparent|theme|void","camera":{"distance":4–12,"elevation":-0.4–0.6,"fov":30–60},"motion":{"kind":"rotate|float|pulse|none","speed":0–1.2},"objects":[{"shape":"box|sphere|torus|torusKnot|cone|cylinder|octa|plane|icosa","material":"standard|physical|toon|wireframe","tint":"accent|accent2|fg|muted|surface","scale":0.1–2.2,"pos":[x,y,z],"rot":[x,y,z],"metalness":0–1,"roughness":0–1}],"grain":0–0.3,"orbitControls":false}}
objects 最多 6 个：主体 1 个 scale 1.0–2.0，辅助 2–4 个 scale 0.2–0.6，坐标 |x| ≤ 3。`,
  refine: `[TASK:refine]
你是 LUMEN（幕光）的 AI 编排器。只输出 JSON。
输出契约：{"headline":"≤24 字","lead":"≤40 字","points":["3–5 条，每条 ≤40 字"]}
保留这一页的核心信息，只改变表达与密度；指令说「更短」就把每条压到 20 字以内。`,
}

function splitPipe(value) {
  return String(value ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split(/[｜|]/u)
    .map((part) => part.trim())
}

function chatBody(task, payload, overrides = {}) {
  return {
    model: BASE_MODEL,
    messages: [
      { role: 'system', content: SELFTEST_SYSTEM[task] },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
    temperature: 0.7,
    stream: false,
    ...overrides,
  }
}

function outlinePayload(prompt, overrides = {}) {
  return {
    prompt,
    lang: 'zh',
    audience: '产品与工程团队',
    length: 'normal',
    slideCount: 9,
    durationMin: 12,
    includeSvg: true,
    include3d: true,
    themeId: 'noir',
    ...overrides,
  }
}

function validateSeparator(recipe, point, where) {
  const issues = []
  const parts = splitPipe(point)
  if (recipe === 'data') {
    if (!/^[^=＝]+[=＝][\d.]+%?$/u.test(point)) issues.push(`${where} data 应为「标签=数值」：${snippet(point, 20)}`)
  } else if (recipe === 'timeline') {
    if (parts.length < 3) issues.push(`${where} timeline 应为「时间｜标题｜说明」：${snippet(point, 24)}`)
  } else if (recipe === 'process') {
    if (parts.length < 3) issues.push(`${where} process 应为「步骤｜时长｜说明」：${snippet(point, 24)}`)
  } else if (recipe === 'compare') {
    if (parts.length < 2) issues.push(`${where} compare 应为「组名｜一句话」：${snippet(point, 24)}`)
  } else if (recipe === 'grid3' || recipe === 'grid4') {
    if (!/^\*\*[^*]+\*\*[：:]/u.test(point) && !/^[^：:]{1,12}[：:]/u.test(point)) {
      issues.push(`${where} grid 卡片应为「小标题：一句话」：${snippet(point, 24)}`)
    }
  }
  return issues
}

function validateOutlineContract(value) {
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['顶层不是对象']
  const titleChars = Array.from(String(value.title ?? '')).length
  if (titleChars < 4 || titleChars > 24) issues.push(`title 长度 ${titleChars}（应 ≥4 且 ≤24）`)
  if (typeof value.subtitle !== 'string' || oneLine(value.subtitle) === '') issues.push('subtitle 为空')
  if (value.lang !== 'zh' && value.lang !== 'en') issues.push(`lang=${value.lang}`)
  const slides = Array.isArray(value.slides) ? value.slides : []
  if (!Array.isArray(value.slides)) issues.push('slides 不是数组')
  if (slides.length < 3 || slides.length > 20) issues.push(`幕数 ${slides.length}（应在 3–20）`)
  if (slides[0]?.recipe !== 'cover') issues.push('首幕不是 cover')
  if (slides[slides.length - 1]?.recipe !== 'closing') issues.push('末幕不是 closing')
  let svgCount = 0
  let threeCount = 0
  slides.forEach((slide, index) => {
    const where = `#${index + 1}`
    if (!slide || typeof slide !== 'object') {
      issues.push(`${where} 不是对象`)
      return
    }
    if (!RECIPES.includes(slide.recipe)) issues.push(`${where} recipe=${slide.recipe}`)
    if (typeof slide.headline !== 'string' || oneLine(slide.headline) === '') issues.push(`${where} headline 为空`)
    else if (Array.from(slide.headline).length > 24) issues.push(`${where} headline 超过 24 字`)
    const visual = slide.visual
    if (!visual || typeof visual !== 'object' || !['svg', 'three', 'none'].includes(visual.kind)) {
      issues.push(`${where} visual 非法`)
    } else if (visual.kind === 'svg') {
      svgCount += 1
      if (typeof visual.brief !== 'string' || oneLine(visual.brief) === '') issues.push(`${where} svg brief 为空`)
      else if (Array.from(visual.brief).length > 60) issues.push(`${where} svg brief 超过 60 字`)
    } else if (visual.kind === 'three') {
      threeCount += 1
      if (visual.preset !== undefined && !THREE_PRESETS.includes(visual.preset)) issues.push(`${where} three preset 非法`)
    }
    const points = Array.isArray(slide.points) ? slide.points : null
    if (points === null) {
      issues.push(`${where} points 不是数组`)
    } else {
      if (points.length > 6) issues.push(`${where} 要点超过 6 条`)
      if (['grid3', 'grid4', 'split', 'timeline', 'compare', 'data', 'process', 'gallery'].includes(slide.recipe) && points.length < 3) {
        issues.push(`${where} 要点少于 3 条`)
      }
      if (slide.recipe === 'data' && points.length < 2) issues.push(`${where} 数据点少于 2 条`)
      points.forEach((point, pointIndex) => {
        const pointWhere = `${where}.${pointIndex + 1}`
        if (typeof point !== 'string' || oneLine(point) === '') {
          issues.push(`${pointWhere} 要点为空`)
          return
        }
        if (Array.from(point).length > 40) issues.push(`${pointWhere} 要点超过 40 字`)
        issues.push(...validateSeparator(slide.recipe, point, pointWhere))
      })
      if (slide.recipe === 'compare') {
        const groups = new Set(points.map((point) => splitPipe(point)[0]).filter(Boolean))
        if (groups.size < 2) issues.push(`${where} compare 至少需要两组`)
      }
    }
    if (typeof slide.notes !== 'string' || oneLine(slide.notes) === '') issues.push(`${where} notes 为空`)
    else if (Array.from(slide.notes).length > 60) issues.push(`${where} notes 超过 60 字`)
  })
  if (svgCount > 1) issues.push(`svg 幕 ${svgCount} 个（应 ≤1）`)
  if (threeCount > 1) issues.push(`three 幕 ${threeCount} 个（应 ≤1）`)
  const text = JSON.stringify(value)
  if (/lorem|lorem ipsum|待补充|TODO|占位/i.test(text)) issues.push('出现占位符 / Lorem ipsum')
  if (!/[\u4e00-\u9fff]/.test(text)) issues.push('中文大纲里没有中文')
  return issues
}

function validateSlideContract(value, recipe, brief) {
  const issues = []
  if (!value || typeof value !== 'object') return ['顶层不是对象']
  const headline = typeof value.headline === 'string' ? value.headline : ''
  if (oneLine(headline) === '') issues.push('headline 为空')
  else if (Array.from(headline).length > 24) issues.push('headline 超过 24 字')
  if (value.lead !== undefined) {
    if (typeof value.lead !== 'string') issues.push('lead 不是字符串')
    else if (Array.from(value.lead).length > 40) issues.push('lead 超过 40 字')
  }
  const points = Array.isArray(value.points) ? value.points : null
  if (points === null) issues.push('points 不是数组')
  else {
    const min = recipe === 'compare' ? 4 : 3
    const max = recipe === 'compare' ? 6 : 5
    if (points.length < min || points.length > max) issues.push(`要点数量 ${points.length}（应为 ${min}–${max}）`)
    points.forEach((point, index) => {
      if (typeof point !== 'string' || oneLine(point) === '') {
        issues.push(`points[${index}] 为空`)
        return
      }
      if (Array.from(point).length > 40) issues.push(`points[${index}] 超过 40 字`)
      issues.push(...validateSeparator(recipe, point, `points[${index}]`))
    })
    if (recipe === 'compare') {
      const groups = new Set(points.map((point) => splitPipe(point)[0]).filter(Boolean))
      if (groups.size < 2) issues.push('compare 至少需要两组')
    }
  }
  if (typeof value.notes !== 'string' || oneLine(value.notes) === '') issues.push('notes 为空')
  else if (Array.from(value.notes).length > 60) issues.push('notes 超过 60 字')
  if (brief) {
    const joined = `${(points ?? []).join(' ')} ${value.notes ?? ''}`
    if (!joined.includes(brief.slice(0, 6))) issues.push('brief 没有写进 points/notes（纠偏通道失效）')
  }
  if (/lorem ipsum/i.test(JSON.stringify(value))) issues.push('出现 Lorem ipsum')
  return issues
}

function validateSvgContract(value) {
  const issues = []
  if (!value || typeof value !== 'object') return ['顶层不是对象']
  const source = value.svg
  if (typeof source !== 'string' || !source.trim().startsWith('<svg')) issues.push('svg 不是 <svg> 开头')
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(String(source))) issues.push('缺少 xmlns')
  if (!/viewBox="0 0 820 560"/.test(String(source))) issues.push('缺少 viewBox="0 0 820 560"')
  if (!Array.isArray(value.viewBox) || (value.viewBox || []).join(',') !== '0,0,820,560') issues.push('viewBox 字段必须是 [0,0,820,560]')
  if (typeof value.caption !== 'string' || oneLine(value.caption) === '') issues.push('caption 为空')
  else if (Array.from(value.caption).length > 30) issues.push('caption 超过 30 字')

  const text = String(source)
  const tags = Array.from(text.matchAll(/<\/?([A-Za-z][\w:-]*)/g)).map((match) => match[1])
  for (const tag of new Set(tags)) {
    if (!SVG_ALLOWED_TAGS.includes(tag)) issues.push(`出现白名单外标签 <${tag}>`)
  }
  if (/<text[\s>]/i.test(text)) issues.push('出现 <text>（文字应交给 text 块）')
  if (/<script|<style|<filter|<image|<foreignObject|<iframe/i.test(text)) issues.push('出现被禁标签')
  if (/\sstyle\s*=/i.test(text)) issues.push('出现 style 属性')
  if (/\son[a-z]+\s*=/i.test(text)) issues.push('出现事件属性')
  if (/url\(\s*['"]?(https?:)?\/\//i.test(text)) issues.push('出现外链 url()')
  if (/href\s*=\s*["'](?:https?:)?\/\//i.test(text)) issues.push('出现外链 href')

  const colorAttrs = Array.from(text.matchAll(/\s(fill|stroke|stop-color|color)="([^"]+)"/g)).map((match) => match[2])
  for (const color of colorAttrs) {
    if (color.startsWith('url(#')) continue
    if (!SVG_ALLOWED_COLORS.has(color)) issues.push(`非令牌颜色 ${color}`)
  }
  const withoutPaintRefs = text.replace(/url\(#[^)]*\)/g, '')
  if (/#[0-9a-f]{3,8}\b/i.test(withoutPaintRefs)) issues.push('出现 hex 颜色')
  if (/\b(rgb|hsl)a?\(/i.test(withoutPaintRefs)) issues.push('出现 rgb()/hsl()')

  const widths = Array.from(text.matchAll(/stroke-width="([\d.]+)"/g)).map((match) => Number.parseFloat(match[1]))
  if (widths.length === 0) issues.push('没有任何描边（构图可能过空）')
  for (const width of widths) {
    if (!(width >= 1.4 && width <= 3)) issues.push(`线宽 ${width} 不在 1.4–3`)
  }
  const opacities = Array.from(text.matchAll(/(?:^|\s)opacity="([\d.]+)"/g)).map((match) => Number.parseFloat(match[1]))
  for (const opacity of opacities) {
    if (!(opacity >= 0 && opacity <= 1)) issues.push(`opacity ${opacity} 不在 0–1`)
  }
  if (!/[\u4e00-\u9fff]/.test(oneLine(value.caption))) issues.push('caption 没有中文')
  return issues
}

function validateThreeContract(value) {
  const issues = []
  if (!value || typeof value !== 'object') return ['顶层不是对象']
  const descriptor = value.descriptor
  if (!descriptor || typeof descriptor !== 'object') return ['缺少 descriptor']
  if (!THREE_PRESETS.includes(descriptor.preset)) issues.push(`preset=${descriptor.preset}`)
  if (!['accent', 'mono', 'duotone'].includes(descriptor.palette)) issues.push(`palette=${descriptor.palette}`)
  if (!['studio', 'sunset', 'neon', 'soft'].includes(descriptor.light)) issues.push(`light=${descriptor.light}`)
  if (!['transparent', 'theme', 'void'].includes(descriptor.bg)) issues.push(`bg=${descriptor.bg}`)
  const camera = descriptor.camera ?? {}
  if (!(camera.distance >= 4 && camera.distance <= 12)) issues.push(`camera.distance=${camera.distance}（应 4–12）`)
  if (!(camera.elevation >= -0.4 && camera.elevation <= 0.6)) issues.push(`camera.elevation=${camera.elevation}（应 -0.4–0.6）`)
  if (!(camera.fov >= 30 && camera.fov <= 60)) issues.push(`camera.fov=${camera.fov}（应 30–60）`)
  const motion = descriptor.motion ?? {}
  if (!['rotate', 'float', 'pulse', 'none'].includes(motion.kind)) issues.push(`motion.kind=${motion.kind}`)
  if (!(motion.speed >= 0 && motion.speed <= 1.2)) issues.push(`motion.speed=${motion.speed}（应 0–1.2）`)
  if (!(descriptor.grain >= 0 && descriptor.grain <= 0.3)) issues.push(`grain=${descriptor.grain}（应 0–0.3）`)
  if (descriptor.orbitControls !== false) issues.push('orbitControls 应为 false')
  const objects = Array.isArray(descriptor.objects) ? descriptor.objects : null
  if (objects === null) {
    issues.push('objects 不是数组')
    return issues
  }
  if (objects.length === 0 || objects.length > 6) issues.push(`objects 数量 ${objects.length}（应 1–6）`)
  let mainCount = 0
  objects.forEach((object, index) => {
    const where = `objects[${index}]`
    if (!THREE_SHAPES.includes(object.shape)) issues.push(`${where}.shape=${object.shape}`)
    if (!THREE_MATERIALS.includes(object.material)) issues.push(`${where}.material=${object.material}`)
    if (!THREE_TINTS.includes(object.tint)) issues.push(`${where}.tint=${object.tint}`)
    if (!Array.isArray(object.pos) || object.pos.length !== 3) issues.push(`${where}.pos 非法`)
    else if (!object.pos.every((value) => Number.isFinite(value) && Math.abs(value) <= 3)) issues.push(`${where}.pos 超出 |3|`)
    if (object.scale >= 1 && object.scale <= 2) mainCount += 1
    else if (!(object.scale >= 0.2 && object.scale <= 0.6)) issues.push(`${where}.scale=${object.scale}（辅助应 0.2–0.6）`)
    for (const key of ['metalness', 'roughness']) {
      if (object[key] !== undefined && !(object[key] >= 0 && object[key] <= 1)) issues.push(`${where}.${key} 越界`)
    }
  })
  if (mainCount !== 1) issues.push(`主体对象 ${mainCount} 个（应恰好 1 个 scale 1.0–2.0）`)
  return issues
}

function validateRefineContract(value, mode) {
  const issues = []
  if (!value || typeof value !== 'object') return ['顶层不是对象']
  const isEnglish = mode === 'english'
  const headline = typeof value.headline === 'string' ? value.headline : ''
  if (oneLine(headline) === '') issues.push('headline 为空')
  else if (Array.from(headline).length > (isEnglish ? 72 : 24)) issues.push('headline 过长')
  if (value.lead !== undefined && typeof value.lead !== 'string') issues.push('lead 不是字符串')
  else if (value.lead !== undefined && Array.from(value.lead).length > (isEnglish ? 90 : 40)) issues.push('lead 过长')
  const points = Array.isArray(value.points) ? value.points : null
  if (points === null) issues.push('points 不是数组')
  else {
    const min = mode === 'quieter' ? 2 : 3
    if (points.length < min || points.length > 6) issues.push(`要点数量 ${points.length}（应为 ≥${min}）`)
    points.forEach((point, index) => {
      if (typeof point !== 'string' || oneLine(point) === '') issues.push(`points[${index}] 为空`)
      else if (Array.from(point).length > (isEnglish ? 90 : 40)) issues.push(`points[${index}] 过长`)
    })
    if (mode === 'shorter') {
      points.forEach((point, index) => {
        if (Array.from(String(point)).length > 20) issues.push(`points[${index}] 未压缩到 20 字以内`)
      })
    }
    if (mode === 'timeline') {
      points.forEach((point, index) => {
        if (splitPipe(point).length < 3) issues.push(`points[${index}] 不是「时间｜标题｜说明」`)
      })
    }
    if (mode === 'compare') {
      points.forEach((point, index) => {
        if (splitPipe(point).length < 2) issues.push(`points[${index}] 不是「组名｜一句话」`)
      })
      const groups = new Set(points.map((point) => splitPipe(point)[0]).filter(Boolean))
      if (groups.size < 2) issues.push('对比缺少两个组名')
    }
  }
  if (isEnglish && /[\u4e00-\u9fff]/.test(JSON.stringify(value))) issues.push('要求英文但输出里仍有中文')
  return issues
}

/** 读取一条 SSE 响应，返回所有 `data:` 内容（[DONE] 原样保留）与是否被服务端掐断。 */
async function readSseEvents(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const events = []
  let buffer = ''
  let aborted = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLines = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)))
        const data = dataLines.join('\n').trim()
        if (data !== '') events.push(data)
      }
    }
  } catch {
    // streambreak 场景：服务端 destroy 后 read() 会抛 TypeError，这里视为「被掐断」。
    aborted = true
  }
  return { events, aborted }
}

/** 与 src/ai/validate.ts 的 closeTruncatedJson 同算法的精简实现（自测 badjson 用）。 */
function repairTruncatedJson(text) {
  const start = String(text).indexOf('{')
  if (start < 0) return null
  const source = String(text).slice(start)
  const closers = []
  let inString = false
  let escaped = false
  let lastSignificant = ''
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        lastSignificant = '"'
      }
      continue
    }
    if (char === '"') {
      inString = true
      lastSignificant = '"'
      continue
    }
    if (char === '{') closers.push('}')
    else if (char === '[') closers.push(']')
    else if (char === '}' || char === ']') closers.pop()
    if (!/\s/.test(char)) lastSignificant = char
  }
  let out = source
  if (inString) {
    if (escaped) out = out.slice(0, -1)
    out += '"'
  }
  if (lastSignificant === ',') out = out.replace(/,\s*$/, '')
  else if (lastSignificant === ':') out += ' null'
  for (let index = closers.length - 1; index >= 0; index -= 1) out += closers[index]
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * --selftest：自己起服务 → 用 fetch 打一遍全部契约 → 打印 PASS/FAIL + 首 200 字。
 * 退出码 0 = 全过，1 = 有失败。
 */
async function runSelftest(baseConfig) {
  const results = []
  const logPath = path.join(HERE, 'results', 'llm', 'selftest-requests.jsonl')
  try {
    rmSync(logPath, { force: true })
  } catch {
    /* 上一轮没有日志文件也没关系 */
  }

  const config = { ...baseConfig, port: 0, log: logPath, chunkMs: 2, chunkSize: 24, quiet: true, selftest: false }
  const app = createSimServer(config)
  try {
    await app.listen()
  } catch (error) {
    console.error(`[selftest] 启动模拟服务失败：${error.message}`)
    process.exit(1)
  }
  const port = app.port()
  const base = `http://127.0.0.1:${port}`
  console.log(`[selftest] 模拟服务已启动：${base}（日志 ${logPath}）`)
  console.log('')

  const record = (name, ok, detail = '', snippetText = '') => {
    results.push({ name, ok })
    if (ok) {
      console.log(`PASS  ${name}${snippetText ? ` — ${snippet(snippetText, 200)}` : detail ? ` — ${snippet(detail, 200)}` : ''}`)
    } else {
      console.log(`FAIL  ${name} — ${snippet(detail || '未知原因', 240)}${snippetText ? ` | 首200字：${snippet(snippetText, 200)}` : ''}`)
    }
  }
  const expect = (name, issues, snippetText = '') => record(name, issues.length === 0, issues.join(' | '), snippetText)

  try {
    /* ---------------------------- 1. health ---------------------------- */
    {
      const response = await fetch(`${base}/health`)
      const json = await response.json().catch(() => null)
      const ok = response.status === 200 && json?.ok === true && typeof json.model === 'string' && typeof json.requests === 'number'
      record('GET /health', ok, ok ? '' : `status=${response.status} body=${snippet(JSON.stringify(json), 120)}`, ok ? `model=${json.model} requests=${json.requests} log=${json.log}` : '')
    }

    /* ---------------------------- 2. models ---------------------------- */
    {
      const issues = []
      for (const endpoint of ['/v1/models', '/models']) {
        const response = await fetch(`${base}${endpoint}`)
        const json = await response.json().catch(() => null)
        if (response.status !== 200) issues.push(`${endpoint} status=${response.status}`)
        if (json?.object !== 'list') issues.push(`${endpoint} object!=list`)
        const ids = Array.isArray(json?.data) ? json.data.map((item) => item.id) : []
        for (const required of ALL_MODELS) if (!ids.includes(required)) issues.push(`${endpoint} 缺模型 ${required}`)
      }
      expect('GET /v1/models + /models', issues, ALL_MODELS.join(', '))
    }

    /* ---------------------------- 3. CORS ---------------------------- */
    {
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' })
      const allowOrigin = response.headers.get('access-control-allow-origin')
      const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
      const allowMethods = (response.headers.get('access-control-allow-methods') ?? '').toUpperCase()
      const exposeHeaders = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase()
      const issues = []
      if (response.status !== 204) issues.push(`status=${response.status}（应 204）`)
      if (allowOrigin !== '*') issues.push(`allow-origin=${allowOrigin}`)
      if (!allowHeaders.includes('authorization') || !allowHeaders.includes('content-type')) issues.push(`allow-headers=${allowHeaders}`)
      if (!allowMethods.includes('POST') || !allowMethods.includes('OPTIONS')) issues.push(`allow-methods=${allowMethods}`)
      if (!exposeHeaders.includes('retry-after')) issues.push(`expose-headers=${exposeHeaders}（429 退避需要 retry-after）`)
      expect('OPTIONS 预检 + CORS', issues, `allow-origin=${allowOrigin} allow-headers=${allowHeaders} allow-methods=${allowMethods}`)
    }

    /* ---------------------------- 4. outline ---------------------------- */
    const mainPrompt = '为什么下一季度的复盘，要从 PPT 换成 HTML 演示'
    let outlineContent = ''
    let outlineObject = null
    {
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('outline', outlinePayload(mainPrompt)))
      const json = await response.json().catch(() => null)
      outlineContent = json?.choices?.[0]?.message?.content ?? ''
      const issues = []
      if (response.status !== 200) issues.push(`status=${response.status}`)
      try {
        outlineObject = JSON.parse(outlineContent)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (outlineObject) issues.push(...validateOutlineContract(outlineObject))
      expect('POST outline（非流式 + 契约 + 文案质量）', issues, outlineContent)
    }

    /* ----------------------- 5. outline 幕数 / 语言 ----------------------- */
    {
      const shortResponse = await postJson(`${base}/v1/chat/completions`, chatBody('outline', outlinePayload(mainPrompt, { length: 'short', slideCount: undefined })))
      const shortJson = await shortResponse.json().catch(() => null)
      const shortOutline = JSON.parse(shortJson?.choices?.[0]?.message?.content ?? '{}')
      const deepResponse = await postJson(`${base}/v1/chat/completions`, chatBody('outline', outlinePayload(mainPrompt, { length: 'deep', slideCount: undefined })))
      const deepJson = await deepResponse.json().catch(() => null)
      const deepOutline = JSON.parse(deepJson?.choices?.[0]?.message?.content ?? '{}')
      const issues = []
      if (shortOutline?.slides?.length !== 6) issues.push(`short=${shortOutline?.slides?.length}（应 6）`)
      if (deepOutline?.slides?.length !== 12) issues.push(`deep=${deepOutline?.slides?.length}（应 12）`)
      if (!/^\d+ 分钟$/.test(String(shortOutline?.subtitle ?? '').split(' · ').pop() ?? '')) issues.push(`subtitle 未带时长：${shortOutline?.subtitle}`)
      expect('outline 按 length 出 6 / 12 幕', issues, `short=${shortOutline?.slides?.length} deep=${deepOutline?.slides?.length} subtitle=${shortOutline?.subtitle}`)
    }
    {
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('outline', outlinePayload(mainPrompt, { lang: 'en' })))
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      const issues = []
      try {
        parsed = JSON.parse(content)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (parsed) {
        if (parsed.lang !== 'en') issues.push(`lang=${parsed.lang}`)
        if (/[\u4e00-\u9fff]/.test(content)) issues.push('英文大纲里仍有中文')
        if (!Array.isArray(parsed.slides) || parsed.slides.length !== 9) issues.push(`幕数=${parsed.slides?.length}`)
      }
      expect('outline lang=en 语言跟随', issues, content)
    }
    {
      const response = await postJson(
        `${base}/v1/chat/completions`,
        chatBody('outline', outlinePayload(mainPrompt, { includeSvg: false, include3d: false })),
      )
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      const parsed = JSON.parse(content)
      const visuals = parsed.slides.map((slide) => slide.visual.kind)
      const issues = []
      if (visuals.some((kind) => kind !== 'none')) issues.push(`关掉开关后仍有视觉：${visuals.join(',')}`)
      expect('outline includeSvg/include3d 开关', issues, `visual=${visuals.join(',')}`)
    }

    /* ---------------------------- 6. slide ---------------------------- */
    {
      const seed = outlineObject?.slides?.[2] ?? {}
      const brief = '把结论放在第一行，先给数字'
      const payload = {
        deckTitle: outlineObject?.title ?? '',
        lang: 'zh',
        index: 2,
        total: outlineObject?.slides?.length ?? 9,
        audience: '产品与工程团队',
        brief,
        materials: [{ label: 'Q3 复盘笔记', text: '延迟主要来自评审排队。' }],
        slide: seed,
      }
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('slide', payload))
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      const issues = []
      try {
        parsed = JSON.parse(content)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (parsed) issues.push(...validateSlideContract(parsed, seed.recipe ?? 'grid3', brief))
      expect('POST slide（recipe 分隔符 + brief 纠偏）', issues, content)
    }

    /* ----------------------------- 7. svg ----------------------------- */
    {
      const payload = { prompt: '一条时间线从文档流向外链页面，节点逐一点亮', style: '', viewBox: [0, 0, 820, 560], palette: 'theme-tokens' }
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('svg', payload))
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      const issues = []
      try {
        parsed = JSON.parse(content)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (parsed) issues.push(...validateSvgContract(parsed))
      expect('POST svg（白名单 + 令牌色 + 构图）', issues, content)
    }

    /* ---------------------------- 8. three ---------------------------- */
    {
      const payload = { prompt: '把下一季度的三条主线做成一个可以旋转的结构' }
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('three', payload))
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      const issues = []
      try {
        parsed = JSON.parse(content)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (parsed) issues.push(...validateThreeContract(parsed))
      expect('POST three（threeDescriptorSchema 预算）', issues, content)
    }

    /* ---------------------------- 9. refine ---------------------------- */
    const refineBase = {
      lang: 'zh',
      recipe: 'grid3',
      headline: '复盘为什么总停在总结',
      lead: '结论停在个人笔记里，任务没有名字也没有日期。',
      points: ['**写给自己**：结论停在个人笔记里。', '**没有主人**：任务没有名字，也没有日期。', '**没有代价**：不做，也不会影响下一步。'],
    }
    const refineCases = [
      { mode: 'shorter', instruction: '把这一页改得更短' },
      { mode: 'timeline', instruction: '改成时间轴' },
      { mode: 'compare', instruction: '改成左右对比' },
      { mode: 'quieter', instruction: '安静一点，删掉多余的话' },
      { mode: 'english', instruction: '改成英文' },
      { mode: 'unknown', instruction: '换个说法，让结论更硬一点' },
    ]
    for (const item of refineCases) {
      const response = await postJson(`${base}/v1/chat/completions`, chatBody('refine', { instruction: item.instruction, ...refineBase }))
      const json = await response.json().catch(() => null)
      const content = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      const issues = []
      try {
        parsed = JSON.parse(content)
      } catch {
        issues.push('内容不是 JSON')
      }
      if (parsed) issues.push(...validateRefineContract(parsed, item.mode))
      expect(`POST refine（${item.instruction}）`, issues, content)
    }

    /* ---------------------------- 10. stream ---------------------------- */
    {
      const payload = outlinePayload(mainPrompt)
      const response = await postJson(
        `${base}/v1/chat/completions`,
        chatBody('outline', payload, { stream: true, stream_options: { include_usage: true } }),
      )
      const contentType = response.headers.get('content-type') ?? ''
      const { events, aborted } = await readSseEvents(response)
      const issues = []
      if (response.status !== 200) issues.push(`status=${response.status}`)
      if (aborted) issues.push('流被意外掐断')
      if (!contentType.startsWith('text/event-stream')) issues.push(`content-type=${contentType}`)
      const parsed = []
      for (const data of events) {
        if (data === '[DONE]') continue
        try {
          parsed.push(JSON.parse(data))
        } catch {
          issues.push(`坏帧：${snippet(data, 40)}`)
        }
      }
      const roleFrame = parsed.find((chunk) => chunk?.choices?.[0]?.delta?.role === 'assistant')
      const deltas = parsed
        .filter((chunk) => typeof chunk?.choices?.[0]?.delta?.content === 'string')
        .map((chunk) => chunk.choices[0].delta.content)
      const streamed = deltas.join('')
      const sawFinish = parsed.some((chunk) => {
        const choice = chunk?.choices?.[0]
        return choice && (choice.finish_reason === 'stop' || choice.finish_reason === 'length')
      })
      const sawUsage = parsed.some((chunk) => chunk && Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage)
      const sawDone = events[events.length - 1] === '[DONE]'
      if (!roleFrame) issues.push('缺 role 帧')
      if (deltas.length < 2) issues.push(`delta 帧太少：${deltas.length}`)
      if (!sawFinish) issues.push('缺 finish_reason:stop 帧')
      if (!sawUsage) issues.push('缺 usage 帧')
      if (!sawDone) issues.push('缺 data: [DONE]')
      if (streamed !== outlineContent) issues.push('流式拼回的正文与非流式不一致')
      expect('POST stream（role → delta → finish → usage → [DONE]）', issues, `${streamed}${sawDone ? '' : '（无 DONE）'}`)
    }

    /* -------------------------- 11. 429 限流 -------------------------- */
    {
      const issues = []
      const statuses = []
      const model = 'lumen-sim-429'
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await postJson(
          `${base}/v1/chat/completions`,
          chatBody('outline', outlinePayload(mainPrompt), { model }),
        )
        statuses.push(response.status)
        if (attempt < 2) {
          if (response.status !== 429) issues.push(`第 ${attempt + 1} 次 status=${response.status}（应 429）`)
          if (response.headers.get('retry-after') !== '0') issues.push(`第 ${attempt + 1} 次 retry-after=${response.headers.get('retry-after')}`)
        } else {
          const json = await response.json().catch(() => null)
          const content = json?.choices?.[0]?.message?.content ?? ''
          try {
            JSON.parse(content)
          } catch {
            issues.push('第 3 次不是合法 JSON')
          }
        }
      }
      if (statuses[2] !== 200) issues.push(`第 3 次 status=${statuses[2]}（应 200）`)
      expect('模型开关 lumen-sim-429（2 次 429 + retry-after:0）', issues, `statuses=${statuses.join(',')}`)
    }

    /* ------------------------- 12. badjson 截断 ------------------------- */
    {
      const issues = []
      const model = 'lumen-sim-badjson'
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await postJson(
          `${base}/v1/chat/completions`,
          chatBody('outline', outlinePayload(mainPrompt), { model }),
        )
        const json = await response.json().catch(() => null)
        const content = json?.choices?.[0]?.message?.content ?? ''
        if (attempt < 2) {
          let direct = true
          try {
            JSON.parse(content)
          } catch {
            direct = false
          }
          if (direct) issues.push(`第 ${attempt + 1} 次没有被截断`)
          const repaired = repairTruncatedJson(content)
          if (!repaired || typeof repaired.title !== 'string' || !Array.isArray(repaired.slides)) {
            issues.push(`第 ${attempt + 1} 次 closeTruncatedJson 修不回来`)
          }
        } else {
          let direct = false
          try {
            const parsed = JSON.parse(content)
            direct = typeof parsed.title === 'string' && Array.isArray(parsed.slides)
          } catch {
            direct = false
          }
          if (!direct) issues.push('第 3 次仍不是合法 JSON（计数器没有恢复）')
        }
      }
      expect('模型开关 lumen-sim-badjson（截断 2 次，可被修复）', issues, '前 2 次截断、第 3 次合法')
    }

    /* ------------------------ 13. streambreak 断流 ------------------------ */
    {
      const issues = []
      const model = 'lumen-sim-streambreak'
      const response = await postJson(
        `${base}/v1/chat/completions`,
        chatBody('outline', outlinePayload(mainPrompt), { model, stream: true }),
      )
      const { events, aborted } = await readSseEvents(response)
      const parsed = events.filter((data) => data !== '[DONE]').map((data) => JSON.parse(data))
      const roleFrame = parsed.find((chunk) => chunk?.choices?.[0]?.delta?.role === 'assistant')
      const deltas = parsed.filter((chunk) => typeof chunk?.choices?.[0]?.delta?.content === 'string')
      const sawFinish = parsed.some((chunk) => {
        const choice = chunk?.choices?.[0]
        return choice && (choice.finish_reason === 'stop' || choice.finish_reason === 'length')
      })
      const sawDone = events.includes('[DONE]')
      // §4.6：只有 received.deltas === 0 的断流才会回退到非流式，所以这里必须 0 delta。
      if (!roleFrame) issues.push('缺 role 帧（断流发生在首帧之前）')
      if (deltas.length !== 0) issues.push(`断流前出现了 ${deltas.length} 个正文 delta（必须是 0）`)
      if (sawFinish) issues.push('断流时不应有 finish_reason')
      if (sawDone) issues.push('断流时不应有 [DONE]')
      if (!aborted) issues.push('连接没有被掐断（应触发 fetch 读流异常）')

      const fullResponse = await postJson(
        `${base}/v1/chat/completions`,
        chatBody('outline', outlinePayload(mainPrompt), { model, stream: false }),
      )
      const fullJson = await fullResponse.json().catch(() => null)
      const fullContent = fullJson?.choices?.[0]?.message?.content ?? ''
      try {
        JSON.parse(fullContent)
      } catch {
        issues.push('同模型非流式请求不是合法 JSON')
      }
      expect(
        '模型开关 lumen-sim-streambreak（role 帧后 0 delta 掐断 / 非流式正常）',
        issues,
        `deltas=${deltas.length} role=${Boolean(roleFrame)} 无[DONE]，非流式 ${fullContent.length} 字`,
      )
    }

    /* ----------------------------- 14. 400 ----------------------------- */
    {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model": "lumen-sim-0.3", "messages": [',
      })
      const json = await response.json().catch(() => null)
      const issues = []
      if (response.status !== 400) issues.push(`status=${response.status}（应 400）`)
      if (!json?.error) issues.push('缺少 error 字段')
      if (response.headers.get('access-control-allow-origin') !== '*') issues.push('400 响应缺 CORS')
      expect('POST 坏请求体 → 400 JSON + CORS', issues, JSON.stringify(json))
    }

    /* ---------------------------- 15. 404 / 405 ---------------------------- */
    {
      const issues = []
      const notFound = await fetch(`${base}/nope`)
      const notFoundJson = await notFound.json().catch(() => null)
      if (notFound.status !== 404) issues.push(`404 状态=${notFound.status}`)
      if (!notFoundJson?.error) issues.push('404 缺 error')
      if (notFound.headers.get('access-control-allow-origin') !== '*') issues.push('404 缺 CORS')
      const wrongMethod = await fetch(`${base}/v1/chat/completions`, { method: 'GET' })
      if (wrongMethod.status !== 405) issues.push(`GET 状态=${wrongMethod.status}（应 405）`)
      expect('未知端点 404 / 错误方法 405（均带 CORS）', issues, `404=${notFound.status} 405=${wrongMethod.status}`)
    }

    /* ---------------------------- 16. JSONL 日志 ---------------------------- */
    {
      const issues = []
      const lines = readFileSync(logPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const entries = []
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line))
        } catch {
          issues.push(`日志里有坏行：${snippet(line, 40)}`)
        }
      }
      const required = ['ts', 'model', 'task', 'stream', 'status', 'ms', 'promptChars', 'completionChars', 'responseText', 'request']
      for (const entry of entries.slice(0, 200)) {
        for (const key of required) if (!(key in entry)) issues.push(`日志缺字段 ${key}`)
        if (typeof entry.ts !== 'string' || Number.isNaN(Date.parse(entry.ts))) issues.push('ts 不是 ISO 时间')
        if (typeof entry.request?.system !== 'string' || typeof entry.request?.user !== 'string') issues.push('request.system/user 不是字符串')
        if (typeof entry.responseText !== 'string' || entry.responseText.length > RESPONSE_TEXT_LIMIT) issues.push('responseText 截断不符合 4000 字上限')
      }
      const statuses = new Set(entries.map((entry) => entry.status))
      if (!statuses.has(429)) issues.push('没有记录 429')
      if (!statuses.has(400)) issues.push('没有记录 400')
      if (!entries.some((entry) => entry.truncated === true)) issues.push('没有记录 badjson 截断标记')
      if (!entries.some((entry) => entry.aborted === true)) issues.push('没有记录断流标记')
      if (!entries.some((entry) => entry.stream === true)) issues.push('没有记录流式请求')
      if (entries.length < 12) issues.push(`日志条目偏少：${entries.length}`)
      expect('JSONL 日志（字段 / 400 / 429 / 截断 / 断流）', issues, `共 ${entries.length} 条：statuses=${Array.from(statuses).join(',')}`)
    }
  } finally {
    await app.close()
  }

  const passed = results.filter((item) => item.ok).length
  const failed = results.length - passed
  console.log('')
  console.log(`[selftest] ${failed === 0 ? '全部通过' : '存在失败'}：${passed}/${results.length} PASS，${failed} FAIL`)
  console.log(`[selftest] 请求日志：${logPath}`)
  if (failed > 0) {
    console.log('[selftest] 失败项：')
    for (const item of results) if (!item.ok) console.log(`  - ${item.name}`)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

/* ========================================================================== */
/*                                  入口                                       */
/* ========================================================================== */

async function main() {
  const { config, warnings } = parseArgs(process.argv.slice(2))
  for (const warning of warnings) console.warn(`[sim-llm] ${warning}`)

  if (config.help) {
    console.log(usageText())
    return
  }
  if (config.selftest) {
    await runSelftest(config)
    return
  }

  const app = createSimServer(config)
  try {
    await app.listen()
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(`[sim-llm] 端口 ${config.port} 已被占用：换一个 --port，或先关掉占用进程。`)
    } else {
      console.error(`[sim-llm] 启动失败：${error.message}`)
    }
    process.exit(1)
  }

  const port = app.port()
  console.log(`[sim-llm] listening http://${config.host}:${port}/v1`)
  console.log(`[sim-llm] log: ${app.logPath}`)
  console.log(`[sim-llm] models: ${ALL_MODELS.join(', ')}`)
  console.log(`[sim-llm] stream: ${config.chunkSize} chars / ${config.chunkMs}ms；Ctrl+C 退出`)

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    console.log(`\n[sim-llm] ${signal} → 关闭服务（累计 ${app.state.requests} 个推理请求）`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

main().catch((error) => {
  console.error('[sim-llm] fatal:', error)
  process.exit(1)
})
