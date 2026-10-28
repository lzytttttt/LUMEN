# 05 LLM 接入规格

> 职责：把 `src/ai/provider.ts` 的「一次 `complete`」通道补到 v0.2.0 的工程完成度——三通道矩阵、预设档、流式 SSE、结构化输出降级与修复环、错误码到气泡的映射、退避与去重、响应缓存、成本预算、密钥与 CORS、`replay` 回放，全部给成可直接排期的契约。
> 上游：[00 范围与决策](00-范围与决策.md)（D1–D12、术语 §5、性能 §6、文案 §7、写作规则 §8，冲突以它为准）· 下游：[02 造幕台-界面与交互](02-造幕台-界面与交互.md)、[04 动效与流程可视化](04-动效与流程可视化.md)、[06 端到端模拟跑通](06-端到端模拟跑通.md)、[07 验收与测试矩阵](07-验收与测试矩阵.md)、[09 文案词表](09-文案词表.md)。

**数值标记**：`待测` = 无实测数据，先按此默认值实现并实测回填；`待复核` = 外部公示值，需联网复核；其余数值都给出处（代码行号 / 实测字符数 / 算式）。

---

## 1. 基线：v0.1.0 的通道事实

| 事实 | 代码位置 | 对 v0.2.0 的约束 |
|---|---|---|
| `AiProvider` 只有一个能力 `complete(system+user) → text` | `src/ai/provider.ts:52–69` | 不改语义；流式只能是同一 Promise 的**过程回调** |
| 错误码 5 个：`network/auth/timeout/badJson/notConfigured` | `provider.ts:17` | 只增不删（§6） |
| `MockProvider` 延时 `MOCK_LATENCY_MS = 110`，`MODE==='test'` 时 0 | `provider.ts:74–75` | 保持非流式（D8） |
| `OpenAICompatProvider` 固定 `stream: false`；端点归一补 `/chat/completions` | `provider.ts:169–196` | 增量加 `stream`，归一逻辑不动 |
| `response_format: json_object` 被 400/404/422 + body 含 `json` 拒绝时降级重发一次 | `provider.ts:195–209` | 扩成三档降级（§5） |
| 超时 `Math.max(1000, timeoutMs \|\| 90_000)`，单 `AbortController` | `provider.ts:243–258` | 拆成三层计时器（§4.4） |
| `401/403 → auth`，其余非 2xx → `network`，detail 截断 180 字符 | `provider.ts:279–283` | 扩成状态码 × body 特征矩阵（§6） |
| 路由 `isLlmReady(llm) ? openai : mock` | `provider.ts:288`, `settingsStore.ts:95` | 加 `replay` 前置分支，其余不变 |
| `isLlmReady` **不要求 apiKey** | `settingsStore.ts:95–97` | Ollama 免 key 天然成立，不要加 key 判据 |
| `LlmSettings` 现有 **7** 个字段（`provider/baseURL/apiKey/model/temperature/jsonMode/timeoutMs`） | `settingsStore.ts:11–19` | 增量 8 字段，全可选（§14） |
| `provider.complete` 调用点 10 处，其中 5 处带 repair 回调且门是 `provider.id === 'openai'` | `compose.ts:95,107,241,253`、`generate.ts:46,58,86,98`、`refine.ts:300,306` | 旧调用点 **0 改动**；`=== 'openai'` 对新 id 自动为假（有意） |
| 并发池固定 2 | `compose.ts:380–400` | 调 3 需同时满足四条件（§7.4） |
| 单库 `lumen-deck` v2、三 store（`decks/assets/settings`），头注释记录了「一次 upgrade 建齐」的教训 | `persistence/kv.ts:9–15` | 加 `aiCache` 必须 `DB_VERSION 2 → 3` |
| 设置持久化到 `settings` store 的 `app-settings` 键；`hydrate` 用 `{...DEFAULT_LLM, ...snapshot.llm}` 合并 | `persistence/decks.ts:59–65`、`settingsStore.ts:66–72` | 老数据不炸的地基，迁移只加 1 行（§14.2） |
| `.lumen.json` 只含 `kind/schemaVersion/exportedAt/deck/assets` | `export/projectFile.ts:26–35` | key 天然不进工程文件（§10） |
| 独立 HTML 只内联播放器内核 + deck + assets | `export/standalone.ts` | key 天然不进导出物（§10） |
| 未做：流式、重试、缓存、成本、回放 | — | 本规格的全部新增 |

### 1.1 增量原则（五条硬线）

| # | 原则 | 具体到代码 |
|---|---|---|
| P1 | `complete` 的入参出参**只加可选字段** | 10 处旧调用零改动，`stream`/`onDelta` 缺省即旧行为 |
| P2 | 通道 id 只加宽不替换 | `'mock' \| 'openai' \| 'replay'`；`providerFor` 新增前置分支 |
| P3 | 错误码只增不删 | `reasonOf()` 现有 3 个 if 保持命中（`ComposerPanel.tsx:84–88`） |
| P4 | 降级只降不升 | `format` / `capabilities` 一次判定后写回设置，同 00 §6 的 tier 原则 |
| P5 | 零新运行时依赖（D11） | SSE 解析、退避、LRU、字段流全部手写，总增量 ≤ 600 行（估） |

---

## 2. 通道矩阵

| id | 实现 | 职责 | 就绪判据 | 离线行为 | 流式 |
|---|---|---|---|---|---|
| `mock` | `MockProvider` | 确定性演示机 + 单测地基（同 prompt 同结果） | 恒就绪 | 完全离线，零网络 | 否（D8，一次落位） |
| `openai` | `OpenAICompatProvider` | 真模型：DeepSeek / OpenAI / Ollama / 自建网关 / `self` | `isLlmReady(llm)`（**判据不变**） | 不就绪 → 静默落 `mock`（现有行为，保留） | 是（D8） |
| `replay` | `ReplayProvider`（新） | 离线演示与 e2e 的**唯一真相**（D9） | `provider === 'replay'` 且 fixture 命中（严格模式见 §12.5） | 完全离线，按录制节奏回放帧 | 是（回放真帧） |

**路由判定顺序**（`providerFor` 的增量，其余分支原样）：

```ts
providerFor(llm) =
  llm.provider === 'replay' ? new ReplayProvider(replaySetFromLocation())  // 不看 baseURL/model；fixture 集由 ?replay=<set> 选，默认 zh-normal
: isLlmReady(llm)           ? new OpenAICompatProvider(llm)       // 现有分支，一字不改
:                             new MockProvider()                  // 现有兜底
```

**未就绪时的处置表**（决定"静默降级"还是"报错"）：

| 情形 | v0.1.0 | v0.2.0 |
|---|---|---|
| `openai` 但 baseURL/model 空 | 静默 `mock` + 徽标「离线示例模式」 | 不变 |
| `replay` 但 fixture 缺 | 通道不存在 | **抛 `notConfigured`**，不静默落 mock（否则 e2e 假绿） |
| `replay` 但 digest 不匹配 | 通道不存在 | 严格模式抛错，宽松模式按 task 兜底（§12.5） |

### 2.1 TS 类型增量（`provider.ts`）

```ts
export type AiChannelId = 'mock' | 'openai' | 'replay'
export type AiFormat = 'auto' | 'json_object' | 'json_schema' | 'none'

export interface AiUsage { prompt: number; completion: number; total?: number; cachedPrompt?: number }

export interface AiCapabilities {
  stream: boolean
  usageInStream: boolean
  jsonObject: boolean
  jsonSchema: boolean
}

export interface CompleteRequest {          // 旧 5 字段保持原义
  system: string
  user: string
  json?: boolean
  temperature?: number
  signal?: AbortSignal
  /* ↓ 增量，全部可选；缺省 = 旧行为 */
  stream?: boolean
  schema?: { name: string; json: unknown }
  task?: 'outline' | 'slide' | 'svg' | 'three' | 'refine'
  onDelta?: (text: string, meta: { index: number; at: number }) => void
  onUsage?: (usage: AiUsage) => void
}

export interface CompleteResult {           // 旧 2 字段保持原义
  text: string
  usage?: AiUsage
  /* ↓ 增量 */
  streamed?: boolean
  finish?: 'stop' | 'length' | 'aborted'
  model?: string
  cached?: boolean
  effectiveFormat?: AiFormat
}

export interface AiProvider {
  id: AiChannelId            // 加宽
  label: string
  capabilities?: AiCapabilities   // 缺省按全 false 解释 = v0.1.0 行为
  complete(req: CompleteRequest): Promise<CompleteResult>
}
```

读取规则：`provider.capabilities ?? { stream: false, usageInStream: false, jsonObject: false, jsonSchema: false }`，因此旧实现（含第三方实现）不需要感知新字段。

---

## 3. 预设档

| preset | baseURL | model | 需要 key | 默认 format | 首字节超时 | 并发 | 注意点 |
|---|---|---|---|---|---|---|---|
| `mock` | — | — | 否 | `none` | — | — | 110ms 确定性；`test` 下 0 |
| `deepseek` | `https://api.deepseek.com` | `deepseek-chat` | 是 | `auto` | 12 000 待测 | 2 | `/v1` 可省（端点归一自动补 `/chat/completions`）；`402` = 余额不足 → `quota`；浏览器 CORS 待测 |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini`（默认）/ `gpt-4.1`（能力档） | 是 | `json_schema` | 12 000 待测 | 2 | 流式 usage 需 `stream_options.include_usage`；不传 `max_tokens`（o 系要用 `max_completion_tokens`，本规格一律不设上限）；CORS 待测 |
| `ollama` | `http://127.0.0.1:11434/v1` | `qwen2.5:7b`（示例，待定） | 否 | `none` | 30 000 待测 | **1** | 冷启动 3–10s 待测；需 `OLLAMA_ORIGINS`；`json_object` 支持不稳，直接 `none` |
| `gateway` | `https://GW_HOST/v1` | 网关自定 | 视网关 | `auto` | 12 000 待测 | 2 | 必须回 CORS 头（§11.2-A）；`GET /models` 需可用（设置页探测）；别在网关与本机各设一次超时 |
| `self` | `SELF_BASE_URL`（`VITE_LLM_SELF_BASE`） | `SELF_MODEL`（`VITE_LLM_SELF_MODEL`） | 视网关 | `auto` | 12 000 待测 | 2 | alias 固定为 `self`；指向**本会话模型的 OpenAI 兼容网关**；发行包该 env 为空 → 未就绪；是 `06` 录制 fixture 的唯一来源 |

```ts
// presets.ts —— 纯数据，无副作用；选档只写 LlmSettings 的 7 个字段（含 presetId）
export type PresetId = 'mock' | 'deepseek' | 'openai' | 'ollama' | 'gateway' | 'self'
export interface ChannelPreset {
  id: PresetId
  labelKey: string        // i18n key（ai.panel.preset.*），不写字面量
  provider: AiChannelId
  baseURL: string         // self 用占位符 SELF_BASE_URL，绝不写死
  model: string
  needsKey: boolean
  format: AiFormat
  firstByteTimeoutMs: number
  concurrency: 1 | 2 | 3
}
```

选档规则：写入 `provider/baseURL/model/format/firstByteTimeoutMs/concurrency` + `presetId`；用户手改任一字段后 `presetId = null`（显示为「自定义」），不再回写。

---

## 4. 流式协议（SSE，手写，无依赖）

### 4.1 请求体（流式增量）

```json
{
  "model": "MODEL",
  "messages": [{"role": "system", "content": "SYSTEM"}, {"role": "user", "content": "USER"}],
  "temperature": 0.65,
  "stream": true,
  "stream_options": { "include_usage": true },
  "response_format": { "type": "json_object" }
}
```

`stream_options` 与 `response_format` 走同一种降级：`400/404/422` 且 body 命中 `/stream_options|unknown.*field/i` → 去掉该键重发一次（各降一次，互不叠加）。

### 4.2 帧格式契约

```
data: {"choices":[{"index":0,"delta":{"content":"{ \"title\":"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":767,"completion_tokens":1893}}

data: [DONE]

: ping                                  ← 注释行＝心跳，允许任意位置、任意次数
```

### 4.3 解析规则（逐条可单测）

| # | 规则 | 违例后果 |
|---|---|---|
| 1 | 帧边界 `\n\n`，同时接受 `\r\n\r\n`；行尾单个 `\r` 先剥 | 会丢帧 |
| 2 | 行首 `:` → 心跳，丢弃；空行不是帧内容 | 心跳被当 JSON 解析 → 误报 |
| 3 | `data:` 后仅剥一个前导空格；多行 `data` 用 `\n` 拼接 | 内容首字被吃 |
| 4 | `event:`/`id:`/`retry:` 解析但只有 `event` 被保留（当前无用途） | — |
| 5 | `[DONE]` 后所有字节丢弃（部分网关会多发一帧） | 重复文本 |
| 6 | 单帧 JSON 坏 → `streamBroken`，**不静默跳过** | 文本缺字 → 后续 `badJson` 更难查 |
| 7 | 无 `[DONE]` 但已见 `finish_reason` → 正常收尾 | 误报断流 |
| 8 | 流结束 buffer 非空（半帧）→ 丢弃 + `streamBroken('tail')` | 半 JSON 混进 text |

### 4.4 三层计时器

| 计时器 | 默认 | 起点 | 触发后 |
|---|---|---|---|
| 首字节（收到第一个 `data:` 帧） | `firstByteTimeoutMs = 12_000` 待测 | 请求发出 | abort；未收 delta → 允许一次非流式回退 |
| 帧间隔 idle | `frameIdleMs = 20_000` 待测 | 上一帧到达 | abort，同上 |
| 总时长 | `timeoutMs = 90_000`（**沿用现值**） | 请求发出 | abort，不再回退 |

单次请求的总预算就是 `timeoutMs`，重试与回退都从这笔预算里扣（§7.1）。

### 4.5 `AbortSignal` 传播（必须与 `isAborted` 对齐）

外部 `signal` 与三层计时器共用一个 `AbortController`，`abortReason` 取 `'user' | 'firstByte' | 'idle' | 'total'`：

| abortReason | 抛出的错误 | 说明 |
|---|---|---|
| `user` | `new AiError('timeout', 'aborted', true)` | **唯一**保持这个形状，现有 `isAborted()`（`provider.ts:39–42`）才能命中 → 取消不弹错误 |
| `firstByte` | `AiError('timeout', '首字节超时')` | 可回退 |
| `idle` | `AiError('timeout', '流空闲超时')` | 可回退 |
| `total` | `AiError('timeout', '超过 90000ms')` | 与现状同 |

监听器一律 `{ once: true }` + `finally` 里 `removeEventListener`（照抄 `post()` 的写法）。

### 4.6 断流回退规则

| 断点 | 处置 | 理由 |
|---|---|---|
| 收到 0 个 delta | 用同 body、`stream: false` 重发**一次**；仍失败抛原错误 | 首字节超时多半是该层不支持流式 |
| 收到 ≥1 个 delta | **不重发**；把已收 text 交给修复环，`finish:'aborted'` | 重发会重复计费且动效会跳字 |
| 帧间隔超时且已有 delta | 同上一行 | — |

### 4.7 增量 JSON 解析器（造幕台「逐字成幕」的数据源）

```ts
export interface FieldStreamer {
  push(delta: string): void
  snapshot(): Partial<Record<string, string>>
  end(): void
}
export type FieldEmit = (key: string, value: string, final: boolean) => void
/** keys：顶层字符串字段；数组字段用 'points[n]' 取第 n 个元素。 */
export function createFieldStreamer(keys: readonly string[], emit: FieldEmit): FieldStreamer
```

| 规则 | 说明 |
|---|---|
| 只扫顶层 | 不递归；嵌套对象里的同名 key 不触发（`visual.brief` 不算 `headline`） |
| 起始判定 | `"key"` 后允许任意空白 + `:` + 任意空白 + `"` |
| 转义 | `\\" \\\\ \\/ \\n \\t \\r \\b \\f` 直接映射；`\\uXXXX` 四位未到齐时**不 emit**，到齐后再发 |
| 结束 | 未转义的 `"`；或遇到下一个顶层 key / 闭合 `}` |
| 内存上限 | 缓冲 64KB；超限只保留尾 4KB 续接并暂停 emit（防 SVG 巨型字符串） |
| 未闭合 | `end()` 时 `final:false` 并丢弃该字段值 |
| 复杂度 | 单遍 O(n)，不重扫（1e6 字符输入 < 20ms 作为单测上限） |

用途：`headline` 首字到齐即上屏，`points[0..7]` 逐条落位（上限 8 与 zod 一致）。动效时序归 [04 动效与流程可视化](04-动效与流程可视化.md)，本规格只保证「值是真 token，不是模拟打字」。

---

## 5. 结构化输出与修复环 v2

### 5.1 三种 `response_format` 形态

| 形态 | 请求字段 | 支持者 | 何时使用 |
|---|---|---|---|
| `json_schema` | `{type:'json_schema', json_schema:{name, schema, strict:true}}` | OpenAI gpt-4o 系 | `format==='json_schema'` 且 `capabilities.jsonSchema` |
| `json_object` | `{type:'json_object'}` | OpenAI、DeepSeek（待实测）、多数兼容网关 | `format` 为 `auto`/`json_object` 时 |
| 无 | 不传 | Ollama 等 | `format==='none'` |

`json: true` 仍是管线唯一的"我要 JSON"信号（10 处调用点不变）；`format` 只决定**怎么要**。

### 5.2 能力探测与降级顺序

| 步 | 条件 | 动作 | 记录 |
|---|---|---|---|
| 1 | `format==='json_schema'` | 发 `json_schema` | — |
| 2 | 400/404/422 且 body 命中 `/json\|response_format\|schema/i` | 降为 `json_object` 重发一次 | `capabilities.jsonSchema=false`，`llm.format='json_object'` |
| 3 | 再命中同类错误 | 去掉 `response_format` 重发一次 | `capabilities.jsonObject=false`，`llm.format='none'` |

最多降 2 档（最多 3 次请求）。v0.1.0 的「json_object 被拒 → 去键」是这条链的子集，旧行为不失效。降级只降不升（P4），用户在设置里手改可覆盖。

### 5.3 修复环 v2：仍只回喂一次

| 项 | v0.1.0 | v0.2.0 |
|---|---|---|
| 次数 | `maxRepair = 1` | 不变 |
| issue 数量 | `zodIssues()` 最多 8 条 | 不变，但每条追加「该字段期望形状」一句 |
| 回喂文本 | `repairPrompt(user, issues)` 整段重发 | 不变（整对象重发） |
| 修复请求的重试 | 走同一 `complete`（会重试） | **修复请求 `maxRetries` 降为 1**，避免「修复 × 重试」乘爆 |
| 失败终态 | `AiError('badJson', 前 4 条 issue)` | 不变 |

### 5.4 「只重发失败字段」方案评估

| 维度 | 字段级补丁 | 整对象重发（**选定**） |
|---|---|---|
| 输入 token | −55%（估：只带失败字段 + 上下文摘要） | 基线 |
| 输出 token | −30%（只回补丁） | 基线 |
| 新增代码 | 切片 + 合并 + 数组元素增删冲突 ≈ +120 行、+4 条单测 | 0 |
| 失败率 | 更高：模型缺上下文，`headline` 与 `points` 易失配 | 低 |
| 契约影响 | 破坏 `parseWithRepair(...) → T` 的返回值契约（需引入合并器） | 不变 |
| 结论 | 不做 | 做 |

替代动作：把 issue 列表裁到「失败路径 + 期望形状」，输入增量约 200 token（可忽略），换来同样的"少发点废话"收益。

### 5.5 与流式的组合

结构化 + 流式共存：`json: true` 且 `stream: true` 时照发，`response_format` 由 `format` 决定；流中断流已收文本仍走修复环。Mock 与 `replay(严格)` 不进入修复环（§1「`provider.complete` 调用点」一行的 `=== 'openai'` 门为假）。

---

## 6. 错误码 v2 与界面映射

`AiErrorCode` 从 5 个扩到 11 个。检测单点收敛在 `toAiError(status, bodyText, ctx)`，替换现有 `fail()`：

```ts
export type AiErrorCode =
  | 'network' | 'auth' | 'timeout' | 'badJson' | 'notConfigured'      // 原有 5 个
  | 'rateLimit' | 'quota' | 'contextLength' | 'modelNotFound' | 'streamBroken' | 'cors'  // 新增 6 个
```

| code | 检测条件（可执行） | 中文气泡（≤6 字） | 英文（≤6） | 比 | 按钮 | 自动重试 |
|---|---|---|---|---|---|---|
| `network` | `fetch` 抛 `TypeError` 且不满足 `cors` 判定；或非 2xx 且无下列任何特征 | 网断了 | No net | 2.0 ⚠ | 重试 | 是 |
| `auth` | HTTP 401 / 403 | 密钥不对 | Auth | 1.0 | 换密钥 | 否 |
| `timeout` | 三层计时器任一触发且 `detail !== 'aborted'` | 太慢了 | Slow | 1.33 | 重试 | 是 |
| `badJson` | `content` 为空 / 修复环用尽 / 帧 JSON 坏且无有效文本 | 格式不对 | Format | 1.5 | 重试 | 否 |
| `notConfigured` | `baseURL` 或 `model` 为空；`replay` fixture 缺失 | 没配端点 | No LLM | 1.5 | 去设置 | 否 |
| `rateLimit` | 429 且 body **不**命中额度词 | 太快了 | Busy | 1.33 | 重试 | 是 |
| `quota` | 402；或 429/400 且命中 `/insufficient\|quota\|balance\|余额\|额度/i` | 额度用尽 | Quota | 1.25 | 充值 | 否 |
| `contextLength` | 400/413 且命中 `/context_length\|maximum context\|too many tokens\|上下文/i` | 内容太长 | Long | 1.0 | 减幕数 | 否 |
| `modelNotFound` | 404 且命中 `/model/i`；或 400 且命中 `/model.*(not.*found\|no.*such\|exist)/i` | 模型不在 | Model | 1.25 | 改模型 | 否 |
| `streamBroken` | reader 抛错 / 帧 JSON 坏 / 提前 EOF 且无 `finish_reason` / 尾帧不完整 | 流断了 | Drop | 1.33 | 重试 | 是（仅未收 delta） |
| `cors` | `TypeError` + `location.protocol` 为 http(s) + `new URL(baseURL).host !== location.host` + 一次 `GET /models` 探测同为 `TypeError`（结果缓存 30s） | 跨域被拦 | CORS | 1.0 | 换网关 | 否 |

判定顺序（必须按此顺序，否则归类错）：`cors` 探测 → `quota` → `contextLength` → `modelNotFound` → `rateLimit` → `auth` → `network`。

**长度比**列按 00 §7 第 7 条（同 key 中英差 ≤ 1.6×）核对；`network` 的 `No net` 超标（2.0），换词交 [09 文案词表](09-文案词表.md) 定稿。

### 6.1 现有映射的两个修正

| 位置 | v0.1.0 行为 | v0.2.0 |
|---|---|---|
| `ComposerPanel.tsx:87` | `timeout` 一律映射到 `ai.error.aborted`（"生成已取消"）→ 超时被说成取消 | 先 `isAborted(err)` 判定：真取消才 `ai.error.aborted`，否则 `ai.error.timeout`「太慢了」 |
| `ComposerPanel.tsx:88` | 其余 code 落到 `aiErrorMessage`（原始英文片段） | 走 `ai.error.<code>` 短句；detail 只进 `<details>`（默认折叠） |

### 6.2 新增 i18n key（中英各一条，字数由 09 复核）

| key | zh | en |
|---|---|---|
| `ai.error.network` | 网断了 | No net ⚠ |
| `ai.error.rateLimit` | 太快了 | Busy |
| `ai.error.quota` | 额度用尽 | Quota |
| `ai.error.contextLength` | 内容太长 | Long |
| `ai.error.modelNotFound` | 模型不在 | Model |
| `ai.error.streamBroken` | 流断了 | Drop |
| `ai.error.cors` | 跨域被拦 | CORS |
| `ai.error.timeout` | 太慢了 | Slow |
| `ai.panel.preset.{mock,deepseek,openai,ollama,gateway,self}` | 本地 / DeepSeek / OpenAI / Ollama / 网关 / 本模型 | Mock / DeepSeek / OpenAI / Ollama / Gateway / Self |
| `ai.panel.format.{auto,json,strict,off}` | 自动 / JSON / 严格 / 关闭 | Auto / JSON / Strict / Off |
| `ai.retry.n` | `重试 {n}/2` | `Retry {n}/2` |

---

## 7. 重试、并发与幂等

### 7.1 指数退避参数

| 参数 | 值 | 出处 / 说明 |
|---|---|---|
| 基数 `base` | 600ms | 待测（首帧延迟量级参考 Mock 110ms 与真模型 P50） |
| 倍率 | 2.0 | 600 → 1 200 → 2 400 |
| 上限 `cap` | 8 000ms | 待测 |
| jitter | `0.8 + 0.4 × random()`（equal jitter） | 避免同批 2 个请求同相撞 |
| 最大尝试 | 3（1 次 + 2 重试）；设置可 0–3 | `maxRetries` 默认 2 |
| `Retry-After` | 优先，上限 10 000ms | 服务端让等就等，但不超过总预算 |
| 单请求总预算 | `timeoutMs`（90 000）**含**重试与回退 | 剩余预算 < 下次退避 → 直接放弃并抛当前错误 |
| 修复请求的重试 | 1 | §5.3 |
| 计数上限 | 单套 40 次请求 | 超出即停重试与修复，直接走大纲兜底（不新增错误码） |

### 7.2 不重试清单

`auth` · `quota` · `notConfigured` · `contextLength` · `modelNotFound` · `cors` · `badJson` · 任何 `isAborted()` 为真的失败。`streamBroken` 仅在「未收到 delta」时重试（§4.6）。

### 7.3 幂等：同一 `promptDigest` 并发去重

```ts
const inflight = new Map<string, Promise<CompleteResult>>()
function requestDigestOf(req: CompleteRequest, llm: LlmSettings): string {
  return shortHash([req.system, req.user, llm.model, String(req.temperature ?? llm.temperature),
                    llm.format, req.task ?? ''].join('\u0000'))    // 10 位 base36，复用 ids.ts:19
}
```

| 规则 | 说明 |
|---|---|
| 同 digest 并发 | 共享同一个 Promise，`onDelta` 多播给所有订阅者（第二个调用 0 次 HTTP） |
| 清理 | 成功/失败/abort 后一帧内 `inflight.delete(digest)` |
| 与 provenance 的 `promptDigest` 区别 | `stampBlocks` 用的是**套级** `shortHash(prompt ?? outline.title)`（`compose.ts:341,374`）；本处是**请求级**。同名不同义，实现时必须走 `requestDigestOf`，禁止互用 |
| 跨会话 | 不共享；`replay` 通道不进去重表（fixture 本身确定） |

### 7.4 并发 2 → 3 的调优条件

四条**全部**满足才允许 3，任一不满足回落 2：

| # | 条件 | 观测来源 |
|---|---|---|
| 1 | 近 10 次请求无 `rateLimit` | 本地计数器（IndexedDB） |
| 2 | 端点 P50 首字节 > 1 500ms（瓶颈在对端，不在本机） | 每次请求记录首字节耗时 |
| 3 | 用户在设置里显式开启「更快并发」 | 设置项 |
| 4 | 单幕平均请求数 ≤ 2（含修复），即修复率 < 50% | 计数器 |

硬顶 3（纯 Promise 池，无依赖）；`ollama` 档固定 1（显存），不受开关影响。3 并发下进度条与取消的体验代价写进 [02 造幕台-界面与交互](02-造幕台-界面与交互.md)。

### 7.5 重试期间的界面契约

退避等待不弹 toast、不换阶段；Pulse 显示 `重试 {n}/2`（≤6 字），Combo 不加分（D4：游戏层不奖励失败）。只有最终失败弹 1 条气泡（§6 文案 + 1 个动词按钮）。

---

## 8. 响应缓存

### 8.1 记录结构与 store

```ts
// persistence/kv.ts 增量：StoreName 加 'aiCache'；DB_VERSION 2 → 3；STORE_NAMES 追加
export interface AiCacheRecord {
  key: string          // = requestDigestOf(...)，10 位 base36
  task: 'outline' | 'slide' | 'svg' | 'three' | 'refine'
  text: string         // 只存产物文本；system/user 原文不入库
  model: string
  format: AiFormat
  usage?: AiUsage
  bytes: number        // text.length（UTF-16 code unit，够做上限估算）
  createdAt: number
  at: number           // 最近命中时间（LRU 依据）
}
```

| 决策 | 值 | 理由 |
|---|---|---|
| store 名 | `aiCache`（第四 store） | 沿用 `kv.ts` 单库多 store；`DB_VERSION` 必须 +1，否则老库不触发 upgrade（文件头记录的教训） |
| 键 | `promptDigest`（请求级） | 见 §7.3 |
| TTL | 7 天（604 800 000ms） | 待校准：模型版本与价格变动周期远长于 7 天 |
| LRU 上限 | 200 条 **或** 合计 4MB（先到者生效） | 待测：单条 outline 文本约 8KB、slide 约 1KB 量级 |
| 淘汰顺序 | 先删过期，再按 `at` 升序删到满足上限 | 纯前端，无索引，用 `kvEntries('aiCache')` 全量扫（200 条可接受） |
| 写入时机 | 请求成功 **且** `parseWithRepair` 通过 | 只缓存合格产物，避免把坏 JSON 缓存成"永远失败" |
| 不缓存 | `replay` 通道、失败文本、`usage` 为 0 的空产物 | — |

### 8.2 命中路径与界面表现

| 环节 | 行为 |
|---|---|
| 查缓存 | `complete` 入口第一件事，命中后**不发网络**、不进 `inflight` |
| 喂动效 | `onDelta(text)` 一次灌完（同帧），`streamed:false, cached:true` |
| 目标首帧 | ≤ 50ms（待测：单条 IndexedDB 读约 2–8ms） |
| 造幕台表现 | 「逐字成幕」改为「整段落位 + 一道 120ms 高亮扫过」，参数归 [04](04-动效与流程可视化.md)；不显示"来自缓存"文字（D5 文字预算） |
| 留痕 | `provenance.cached = true`（`stampBlocks` 入参加可选字段，旧块无此字段） |
| 失效 | 换 `model` / `format` / `temperature` → digest 变 → 自然 miss；设置页提供「清空缓存」（`kvEntries('aiCache')` 全删） |

---

## 9. 预算与成本

### 9.1 一次 9 幕生成（`length: 'normal'`）的请求数

| 阶段 | 请求数 | 触发条件（代码事实） |
|---|---|---|
| 大纲 | 1 | `composeOutline()`，`slideCount` 由 `outlineRequest` 折算为 9（`prompts.ts:82`） |
| 单幕文案 | 9 | 每幕一次 `SLIDE_SYSTEM`（`compose.ts:241`） |
| SVG 幕 | 1 | `OUTLINE_SYSTEM` 约束"全篇最多 1 个 svg 幕" |
| 3D 幕 | 1 | `normalizeOutline` 硬顶 2（`compose.ts:64–69`） |
| 修复环 | ≤ 12 | 每请求最多 1 次（§5.3） |
| **典型** | **12** | 12 ÷ 并发 2 = 6 批 |
| 含一次修复 | 13 | 统计上大纲最易触发 |
| 上限 | 24 | 12 × 2（每请求各修一次） |

风险记账：`normalizeOutline` **只裁 3D 数量、不裁 SVG 数量**，若模型不守 prompt，SVG 请求可能 > 1：9 个 svg 幕时为 1 + 9 + 9 + 2 = **21** 次，各再修一次 = 42，刚好越过 §7.1 的 40 次上限 → 落到兜底路径。建议 v0.2 在 `normalizeOutline` 补 `svg ≤ 1`（1 行，与 prompt 口径一致），排期归 [01 迭代计划](01-迭代计划.md)。

### 9.2 token 估算

system 字符数是 `src/ai/prompts.ts` 实测（含 `${COMMON_RULES}` 411 字符 / `${RECIPE_GUIDE}` 446 字符的插值后长度）；token 用 CJK 修正式 `tok = CJK字符 × 0.6 + 其它字符 × 0.3`。

| 请求 | system 字符（实测） | system tok | user tok（估） | 输出 tok（估） |
|---|---|---|---|---|
| 大纲 | 1 670 | 707 | 60 | 1 900（9 幕 × ~210，含 recipe/visual 元数据） |
| 单幕 | 816 | 374 | 190 | 190（只 headline/lead/points/notes，比大纲每幕少 ~20） |
| SVG | 1 106 | 436 | 55 | 600 |
| 3D | 1 481 | 545 | 25 | 210 |
| `REFINE`（微调，不计入成幕） | 686 | 312 | 120 | 150 |
| **合计/套** | — | — | **输入 ≈ 6.9k** | **输出 ≈ 4.4k** |

口径说明：代码里的 `estimateTokens = ceil(len/4)`（`provider.ts:118–120`）把中文低估约 40%，只服务 Mock 的 UI 计数，**不用于成本**。真实 `usage` 抓回来以后回填本表（[06](06-端到端模拟跑通.md) 的实测记录）。

### 9.3 计价参数（待复核，改这一张表即重算全节）

| 档 | 模型 | 输入 | 输出 | 备注 |
|---|---|---|---|---|
| 经济档 | `deepseek-chat` | ¥4 / 百万 tok | ¥12 / 百万 tok | 官网公示价，待复核；有缓存命中折扣，本表按未命中计 |
| 能力档 | `gpt-4.1` | $2.00 / 百万 tok | $8.00 / 百万 tok | 官网公示价，待复核；汇率按 ¥7.2/$ |

计算式：`cost = IN_tok/1e6 × P_IN + OUT_tok/1e6 × P_OUT`。

### 9.4 单套成本（估算）

| 场景 | 经济档 | 能力档 |
|---|---|---|
| 典型（12 请求，6.9k in / 4.4k out） | 6 904/1e6×4 + 4 420/1e6×12 = 0.0276 + 0.0530 = **¥0.081** | 0.0138 + 0.0354 = $0.049 ≈ **¥0.35** |
| 含一次修复（+807 in / +1 900 out） | **¥0.11** | ≈ **¥0.48** |
| 上限（24 请求，13.8k in / 8.8k out） | **¥0.16** | ≈ **¥0.71** |

结论：一套演示的成本在「一瓶水」量级 → 不做付费墙、不做余额、不做用量上报（D7）。这一节只用来解释"为什么可以让人随便点重铸"。

---

## 10. 密钥与安全

| 面 | 事实 / 规则 |
|---|---|
| 存储位置 | 只有 IndexedDB `settings` store 的 `app-settings` 一条记录（`saveSettings` → `kvSet`），本地明文，永不出网 |
| 展示 | `maskKey()` 输出 `abc••••xyz`（`settingsStore.ts:99–104`）；输入框 `type="password"`、`autoComplete="off"`（现状已如此） |
| 导出 HTML | 只内联播放器内核 + deck + assets（`export/standalone.ts`）→ **无 key** |
| 工程文件 `.lumen.json` | 只含 `kind/schemaVersion/exportedAt/deck/assets`（`export/projectFile.ts:26–35`）→ **无 key**；不需要新增剔除逻辑，但要有回归断言（§13.1） |
| 日志脱敏 | 统一 `redact(text)`：`/sk-[A-Za-z0-9_\-]{12,}/g → sk-***`、`authorization` 头、URL query 的 `key\|api_key\|token=`；`AiError.detail` 维持 ≤180 字符截断（`provider.ts:280`） |
| 缓存 | 只存产物 `text`，不存 `system/user` → 用户原话不会多一份副本 |
| 分享体检 | 导出前 `scanSecrets(deck)`：在 headline/lead/points/notes 里扫 `/sk-\w{12,}\|Bearer\s+\w{12,}/`，命中即阻断并提示「含密钥」（用户可能把 key 粘进 prompt） |
| `self` 档的 key | 只来自构建期 env（`VITE_LLM_SELF_KEY`）；内联会进产物 → **规矩：发行构建禁止设置该 env**，dev only |
| CSP | 模板见 §11.3；`index.html` 现无 CSP meta（实测），加 meta 属 `src` 改动，排期归 [01](01-迭代计划.md) |
| `file://` | 只承诺播放（`doc/07-播放与导出.md` §12 已实测），**不承诺生成**：`file://` 打开时通道强制 `mock`/`replay`（opaque origin 下 IndexedDB 与跨域 fetch 行为按浏览器不同，待测） |

---

## 11. CORS 与网关

### 11.1 纯静态托管直连的失败面

| 失败面 | 表现 | 归因 |
|---|---|---|
| 端点不回 `access-control-allow-origin` | `fetch` 抛 `TypeError`，拿不到 `response` | `cors` |
| 带 `authorization` 头必触发 `OPTIONS` 预检，网关不处理 | 同上 | `cors` |
| Chrome 私有网络访问（页面在公网域、端点在 `127.0.0.1`） | 预检带 `access-control-request-private-network`，缺 `access-control-allow-private-network` 被拦 | `cors`（Ollama 最常见） |
| CSP 未放行 `connect-src` | console 有 CSP 违规，`fetch` 同样 `TypeError` | 先修 CSP，再判 `cors` |
| 混合内容（https 页面 → http 端点） | 直接拦截 | `cors` |

### 11.2 两种落地（都不承诺有后端）

**A. 用户自备网关**（唯一的生产路径）：任意 OpenAI 兼容代理，只需回四个头并转发；端点在 `127.0.0.1` 时再加第五个（PNA）。

```
access-control-allow-origin: <页面 origin，或 *>
access-control-allow-methods: POST, OPTIONS
access-control-allow-headers: authorization, content-type
access-control-max-age: 600
access-control-allow-private-network: true      ← 仅 PNA（127.0.0.1）场景需要
```

**B. 开发期 vite proxy**（仅本地，不影响产物）：

```ts
// vite.config.ts —— server 段增量；构建产物没有 proxy，发行版必须走 A
server: {
  proxy: {
    '/llm': {
      target: process.env.LUMEN_LLM_PROXY ?? 'http://127.0.0.1:11434',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/llm/, ''),
    },
  },
}
```

开发时把 `baseURL` 填 `/llm/v1` → 同源、零 CORS。**不承诺**静态托管下存在任何代理。

### 11.3 CSP 模板

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' <ENDPOINT_ORIGIN_1> <ENDPOINT_ORIGIN_2>;
```

`connect-src` 白名单必须跟着用户 `baseURL` 走 → 只能由构建脚本按当前预设注入（`<ENDPOINT_ORIGIN_n>` 是占位符，不是要写死的域）。`replay`/`mock` 模式下可省掉所有外部 origin。

---

## 12. `replay` 通道规格

### 12.1 定位

`replay` 是离线演示与 e2e 的**唯一真相**（D9）：它把"网络"也变成确定性产物，连 token 边界与帧节奏都固定。它不参与修复环、不写缓存、不重试、不出网。

| 与 `mock` 的边界 | `mock` | `replay` |
|---|---|---|
| 确定性范围 | 产物（同 prompt 同 JSON） | 产物 + 流帧 + 节奏 |
| 用来断言什么 | 管线正确性（槽位/配方/lint） | 动效时序与"真模型产物"等价性 |
| 请求次数 | 真实走管线 | 真实走管线（只是数据来自文件） |

### 12.2 fixture 文件契约

```ts
export interface ReplayFixture {
  kind: 'lumen.replay'
  version: 1
  fixtureId: string        // '<lang>-<length>.<task>.<n>'，例：zh-normal.slide.3
  task: 'outline' | 'slide' | 'svg' | 'three' | 'refine'
  promptDigest: string     // 录制时的请求级 digest（§7.3），严格匹配用
  request: { system: string; user: string; temperature?: number; format?: AiFormat }
  chunks: string[]         // 原样 SSE 帧文本，含 "data: …\n\n"，末尾含 "data: [DONE]\n\n"
  delays: number[]         // 与 chunks 等长；首项是首字节延迟（ms）
  text: string             // 所有 delta 的 content 拼接，契约测试的比对基准
  usage?: AiUsage
  capturedAt: string       // ISO 8601
  capturedFrom: { baseURL: string; model: string; stream: boolean }
}
```

### 12.3 存放位置与体积

| 用途 | 路径 | 约束 |
|---|---|---|
| 回放数据（e2e / 开发） | `fixtures/ai/<lang>-<length>/<task>-<n>.json` | 单套总量 ≤ 120KB（00 未决 4） |
| 离线演示副本 | `plan/v0.2.0/assets/replay/<lang>-<length>/…` | 与上者内容一致（D9 指定两处） |
| 索引 | `fixtures/ai/index.json` | `{ "<lang>-<length>": { outline, slide[], svg[], three[] } }` |

建议覆盖矩阵：`zh/en × short/normal/deep` = 6 套 × 12 请求 ≈ 72 个 fixture；先做 `zh-normal` 与 `en-normal` 两套兜住 e2e。

### 12.4 录制流程（一次真实调用 → fixture）

| 步 | 动作 | 产物 |
|---|---|---|
| 1 | dev server + `self` 档（本会话模型的 OpenAI 兼容网关）+ 真实 `stream: true` | 真请求 |
| 2 | SSE 解析器旁路 tap 同时收集 `chunks`（原始帧文本）、`delays`（`performance.now()` 差）、`usage` | 内存缓冲 |
| 3 | `window.__lumenReplay.dump()` → 下载 JSON | 未命名 fixture |
| 4 | 手工补 `fixtureId`，跑一次契约测试（§13.2） | 入库 |
| 5 | 人工复核：`request` 字段里**不含 key**、不含用户隐私 prompt | 可提交 |

录制代码用 `import.meta.env.DEV` 静态分支包住，发行构建被摇掉。

### 12.5 回放规则

| 项 | 规则 |
|---|---|
| 查表 | 按 `promptDigest` 精确匹配 |
| 严格模式（e2e） | miss 抛 `AiError('notConfigured', 'replay:digest-miss')`，**不静默落 mock** |
| 宽松模式（演示） | 按 `task` + 出现顺序取，记 warning `replay:digest-miss`（prompt 微调后演示仍可跑） |
| 流式节奏 | 按 `delays[i]` 用 `setTimeout` 逐帧 `onDelta`；`speed = LUMEN_REPLAY_SPEED ?? (MODE==='test' ? 0 : 1)` |
| `speed = 0` | 同步一次灌完（e2e 断言布局用） |
| 非流式 | 直接返回 `text` |
| 校验 | 回放文本仍走 `parseWithRepair`（但不回喂，`maxRepair` 传 0） |

---

## 13. 测试策略

### 13.1 单测（vitest 环境 `jsdom`，假 timer）

| 文件 | 用例 | 断言要点 |
|---|---|---|
| `tests/unit/sse.test.ts` | 9 | 帧边界切在 `\r\n\r\n` 中间；多行 `data`；`:` 心跳；`[DONE]` 后多余字节丢弃；坏 JSON 帧 → `streamBroken`；无 done 但有 `finish_reason` → 正常；半帧 → 丢弃；中文 UTF-8 跨 3 个 chunk 按 code unit 切；空 `data:` 行 |
| `tests/unit/stream-json.test.ts` | 7 | key 被切两半；转义 `\"`；`\u4e2d` 逐位到达；`points[2]` 跨 chunk；未闭合在 `end()` 丢弃；64KB 上限暂停；1e6 字符 < 20ms |
| `tests/unit/backoff.test.ts` | 5 | 600/1 200/2 400 与 cap 8 000；jitter 落在 ±20%；`Retry-After` 优先；不重试码逐一断言；剩余预算不足即放弃 |
| `tests/unit/ai-cache.test.ts` | 6 | 命中不发 fetch；TTL 过期再发；LRU 按 `at` 淘汰；坏 JSON 不入缓存；换 model 自然 miss；`kv` 降级到内存模式仍工作 |
| `tests/unit/ai.test.ts`（存量 549 行） | 不改 | 作为回归基线；新增字段全可选，旧用例必须原样通过 |
| `tests/unit/i18n.test.ts`（存量） | +1 | 新 key 中英各一条且长度比 ≤ 1.6× |
| `tests/unit/export.test.ts`（存量） | +1 | 断言 `.lumen.json` 与独立 HTML 里都搜不到 `apiKey` 值 |

### 13.2 契约测试（`tests/contract/replay.test.ts`）

遍历 `fixtures/ai/**`，四条断言：① `chunks.join('')` 经 SSE 解析出的 text **等于** `fixture.text`；② `fixture.text` 过对应 zod（`outlineSchema` / `slideContentSchema` / `svgPayloadSchema` / `threeDescriptorSchema`）必须通过——即回放产物与真模型产物**可校验等价**；③ 用 `fixture.request` 重算 `promptDigest` 与记录一致；④ 单文件 ≤ 120KB。

前置改造：`slideContentSchema`（`compose.ts:33`）、`svgPayloadSchema` / `threePayloadSchema`（`generate.ts:19–25`）目前是模块内私有，需各加 `export`（3 行，无行为变化）。

### 13.3 e2e（离线全流程，`tests/e2e/forge.spec.ts`）

`?channel=replay&speed=0` + `page.route('**', route => route.abort())`（放行 localhost）；断言：起念 → 抽幕（9 张卡）→ 铸造（9 幕落位）→ 过检（0 个 error）→ 开演；`data-lumen-forge` 存在；零外部请求；console 零 error；首屏可交互 ≤ 400ms（00 §6.2）。

### 13.4 真实端点冒烟（手动，证据进 [06](06-端到端模拟跑通.md)）

5 条：设置页「测试连通性」→ 一次大纲 → 一次单幕 → 一次 SVG → DevTools offline 强制断流。每条记录 `usage`、首字节耗时、实际 `format` 生效档位、错误码与气泡文案。

---

## 14. 兼容与迁移

### 14.1 `LlmSettings` 字段迁移表

| 字段 | v0.1.0 | v0.2.0 | 迁移规则 |
|---|---|---|---|
| `provider` | `'mock' \| 'openai'` | 加 `'replay'` | 旧值原样；`openai` 语义不变（仍是"真端点"） |
| `baseURL` / `apiKey` / `model` / `temperature` | 存在 | 不变 | 原样 |
| `jsonMode` | `true`：允许发 `response_format` | 收窄为 `format !== 'none'` 的快捷开关 | `true → format='auto'`；`false → 'none'`；写新值时同步回 `jsonMode` |
| `timeoutMs` | 单次 fetch 总超时 | 收窄为**总超时**（唯一的预算层，覆盖首字节 + 帧间隔 + 重试） | `Math.max(1000, …)` 判定不变（`provider.ts:244`） |
| `format`（新） | — | `'auto'` | 由 `jsonMode` 推导 |
| `stream`（新） | — | `true`（D8；`mock` 不受影响） | 默认值 |
| `firstByteTimeoutMs`（新） | — | 12 000 | 夹取 3 000–120 000，`ollama` 档预设 30 000 |
| `frameIdleMs`（新） | — | 20 000 | 夹取 5 000–120 000 |
| `maxRetries`（新） | — | 2 | 夹取 0–3 |
| `cache`（新） | — | `true` | — |
| `concurrency`（新） | — | 2 | 夹取 1–3 |
| `presetId`（新） | — | `null` | 选档写入，手改字段后置 null |

### 14.2 迁移实现契约（幂等，纯函数）

```ts
export const DEFAULT_LLM_V2: LlmSettings = {
  ...DEFAULT_LLM,                     // 现有 7 字段原值
  format: 'auto', stream: true, firstByteTimeoutMs: 12_000, frameIdleMs: 20_000,
  maxRetries: 2, cache: true, concurrency: 2, presetId: null,
}

/** 幂等：DEFAULT_LLM_V2 ← 覆盖 raw → jsonMode/format 互推 → 数值夹取。 */
export function migrateLlm(raw: Partial<LlmSettings> | null | undefined): LlmSettings
```

`hydrate` 只改一行（`settingsStore.ts:70`）：`llm: migrateLlm({ ...DEFAULT_LLM, ...(snapshot?.llm ?? {}) })`。现有 merge 已保证缺字段不炸，加 `migrateLlm` 是为了**推出来的 `format`** 和数值夹取。

### 14.3 老数据不炸的三种情形

| 情形 | v0.1.0 行为 | v0.2.0 行为 |
|---|---|---|
| 首启（从未存过 settings） | `hydrate(null)` → `DEFAULT_SETTINGS` | 同，新字段取默认 |
| v0.1.0 存过设置 | merge 保留用户值 | `migrateLlm` 推 `format`，`jsonMode` 仍为 `true` |
| 手改过 kv、缺 `provider` | merge 补 `'mock'` | 同 |

### 14.4 `jsonMode` 与 `timeoutMs` 的语义变化

| 位置 | v0.1.0 | v0.2.0 |
|---|---|---|
| 请求体 | `json===true && jsonMode` → 带 `json_object` | `format` 决定形态（`json_schema`/`json_object`/无）；`json` 仍由管线传 |
| 设置 UI | 一个开关 | 四态选择（自动/JSON/严格/关闭）+ 保留原「JSON 模式」开关作为 `auto ↔ none` 快捷（复用现有 i18n key，避免词表膨胀） |
| `timeoutMs` | 每次 `fetch` 的超时 | 每次**请求（含回退与重试）**的总预算；内层首字节/帧间隔另有默认值，用户不需理解 |

### 14.5 破坏性清零项：无

`AiErrorCode` 只增；`AiProvider` 入参出参只加可选字段；`channelInfo` 返回加 `channel` 字段（`id`/`ready` 语义不变）→ 唯一调用点 `ComposerPanel.tsx:65,173–175,231` 需 2 行调整，让 `replay` 不落到「离线示例模式」提示。其余 10 处 `complete` 调用点、5 处 `currentProvider()` 零改动。

---

## 未决

1. **三家的浏览器直连 CORS 结论没有实测**：DeepSeek / OpenAI / Ollama 在真实静态托管 origin 下的预检结果未采集，§11.1 的归因按经验写。需在 [06](06-端到端模拟跑通.md) 跑通时补一张「端点 × origin × 结果」实测表，否则 §11.2-A 的头清单只是必要条件。
2. **`firstByteTimeoutMs = 12 000` / `frameIdleMs = 20 000` 缺数据**：本地 Ollama 冷启动据经验 > 10s，写死 12s 会让首次生成必然失败。需 5 次实测的 P50/P95 后定值，可能要把 `ollama` 档单独抬到 30s。
3. **缓存容量与 TTL 未按真实产物体积校准**：200 条 / 4MB 是按"outline ≈ 8KB、slide ≈ 1KB"的粗估推的，需用 fixture 实测均值重算；若单套 12 条占 20KB，200 条 = 4MB 正好卡线，可能该降到 150 条。
4. **`replay` 严格模式与 prompt 微调天然冲突**：任何 prompt 文案改一个字，`promptDigest` 全 miss。当前定「e2e 严格 / 演示宽松」，需 [07 验收与测试矩阵](07-验收与测试矩阵.md) 认可"宽松模式按 task 兜底"不算假绿；另一种选择是把 `promptDigest` 只对 `user` 计算（system 版本号单独记），代价是 system 改动不会让缓存失效。
