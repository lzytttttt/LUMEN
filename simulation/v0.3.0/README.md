# v0.3.0 · 模拟 LLM 全链路实战成果

> 这一份是**运行结果**目录。可重复执行：`pnpm sim:llm`；服务契约自测：`pnpm sim:llm:selftest`。
> 完整可视化报告：**[`results/report.html`](results/report.html)**（含全部截图） · 机器可读：`results/report.json`。

## 结论（最后一次运行）

| 指标 | 值 |
|---|---|
| 步骤 | **19 / 19 通过**，0 失败 |
| LLM 请求 | **34 次**（outline 8 · slide 18 · svg 3 · three 4 · refine 1） |
| 模拟端点 | `http://127.0.0.1:5299/v1` · `lumen-sim-0.3`（strict JSON + SSE 流式） |
| 总耗时 | 约 45.5s（含浏览器启动、设置、全部场景） |
| console error | 2（均为鲁棒性场景预期：429 / 断流）· 预期外 **0** |
| page error | 0 |
| 失败请求 | 1（断流演练主动掐断的连接，预期内）· 预期外 **0** |

## 覆盖到的功能面

| # | 场景 | LLM 调用 | 证据 |
|---|---|---|---|
| 1 | 设置里切到模拟端点并测连通性 | `GET /models` | `01-settings-connected.png` |
| 2 | 造幕台：一句话 → 9 幕大纲（受众 / 预设进入请求） | outline | `02-forge-seed.png`、`03-forge-deal.png` |
| 3 | 逐幕「这一幕想讲什么」进入生成请求 | slide（brief） | `04-forge-deal-brief.png` |
| 4 | 九幕成稿：文案 + SVG + 3D + 过检 | slide ×9、svg、three | `05-forge-cast-mid.png`、`06-forge-premiere.png` |
| 5 | 全屏播放真实成稿 | — | `07/08/09-play-slide-*.png` |
| 6 | 落库与 AI 溯源（9 幕、text/shape/svg/three、provider=openai） | — | `10-editor-generated.png` |
| 7 | AI 编排（精密模式）：大纲 + 逐幕成稿 | outline、slide ×9 | `11/12/13-composer-*.png` |
| 8 | 自然语言微调：规则未命中 → 模型改写 + diff | refine | `14/15-refine-*.png` |
| 9 | 微调里的「加配图 / 加 3D」 | svg、three | `16-refine-art.png` |
| 10 | SVG 工作室：一句话 → 可净化 SVG | svg | `17-studio-svg.png` |
| 11 | 3D 工作室：一句话 → 受限描述符 | three | `18-studio-three.png` |
| 12 | 截断 JSON → 修复 / 重试 | outline | `19-robust-badjson.png` |
| 13 | 429 → Retry-After 退避重试 | outline ×3 | `20-robust-429.png` |
| 14 | SSE 断流（0 delta）→ 同 body 非流式回退 | outline ×2 | `21-robust-streambreak.png` |

## 文件

```
simulation/v0.3.0/
├── mock-llm-server.mjs      # 零依赖模拟 OpenAI 兼容端点（SSE / 严格 JSON / 鲁棒性开关 / JSONL 日志 / --selftest 23 项）
├── scenarios.mjs            # 五类任务的高质量确定性内容（3 套手写中文大纲 + 英文明降级 + 结构化兜底）
├── run-simulation.mjs       # Playwright 端到端驱动（19 步）
├── README.md                # 本文件
└── results/
    ├── report.html          # 可视化报告（先看这个）
    ├── report.md / report.json
    ├── console-run.txt / run.log
    ├── screenshots/         # 21 张证据截图
    ├── llm/requests.jsonl   # 34 条真实请求 / 响应（含 system + user prompt）
    ├── llm/requests.pretty.json
    └── browser/             # console / page / failed-request 分类
```

## 复现

```powershell
pnpm sim:llm:selftest   # 先验模拟服务：23/23 PASS
pnpm sim:llm            # 全套实战；结果覆盖 results/
```

前置：`node_modules` 已安装；5273 有 dev server 时复用，没有则自动在 5275 起一个；5299 的模拟服务由 runner 自动拉起 / 关闭。

## 边界

- `scenarios.mjs` 是确定性样张生成器，不是真模型；它验证的是**管线、契约、UI 与视觉**，不代表真实模型能力。
- 鲁棒性场景使用模型名开关（`lumen-sim-badjson` / `lumen-sim-429` / `lumen-sim-streambreak`），不靠改产品代码。
- 截图统一 `?still=1&onboard=0`（L0，零动效等待），保证可重复。
