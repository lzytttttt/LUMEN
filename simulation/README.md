# 模拟 LLM 实战 / Simulated LLM runs

这里放「用自建的模拟 OpenAI 兼容端点，把 LUMEN 所有接 LLM 的功能真实跑一遍」的脚本与证据。
它不是单测的替代品：单测用 jsdom 假 fetch，这里走真实浏览器、真实 HTTP、真实 SSE、真实 IndexedDB 落库。

## 目录

| 路径 | 作用 |
|---|---|
| `v0.3.0/mock-llm-server.mjs` | 零依赖的模拟模型服务：OpenAI 兼容、SSE 流式、严格 JSON、确定性内容、请求日志、鲁棒性开关 |
| `v0.3.0/scenarios.mjs` | 五类任务（outline / slide / svg / three / refine）的高质量中文内容 |
| `v0.3.0/run-simulation.mjs` | Playwright 端到端驱动：造幕台、AI 编排、微调、SVG/3D 工作室、三条鲁棒性路径 |
| `v0.3.0/results/` | 运行产物：`report.html` / `report.md` / `report.json`、截图、LLM 请求 JSONL、console 与失败请求 |

## 运行

```powershell
# 1) 只看模拟模型服务是否满足契约（会自己起停，无需浏览器）
pnpm sim:llm:selftest

# 2) 全套实战（自动复用 5273 上的 dev server；没有就在 5275 起一个；自动起停模拟 LLM）
pnpm sim:llm

# 指定页面地址 / 端口 / 有头模式
node simulation/v0.3.0/run-simulation.mjs --base http://127.0.0.1:5273 --port 5299 --headed
```

## 覆盖的功能

| 用户功能 | 走到的 LLM 调用 | 证据 |
|---|---|---|
| 造幕台：一句话 → 大纲 | `outline` | 9 张幕卡、`03-forge-deal.png` |
| 造幕台：九幕成稿 | `slide` ×9 | 生成中帧、开演席、播放三帧 |
| 造幕台：SVG 文案幕 / 3D 幕 | `svg`、`three` | 落库块类型 + `10-editor-generated.png` |
| AI 编排（精密模式） | `outline`、`slide` ×N | `12/13-composer-*.png` |
| 自然语言微调 | `refine`（规则未命中时） | `14/15-refine-*.png` |
| 微调里的「加配图 / 加 3D」 | `svg`、`three` | `16-refine-art.png` |
| SVG 工作室 | `svg` | `17-studio-svg.png` |
| 3D 工作室 | `three` | `18-studio-three.png` |
| 截断 JSON | 修复 / 修复重试 | `19-robust-badjson.png` + 请求日志 |
| 429 | Retry-After 退避重试 | `20-robust-429.png` + 请求日志 |
| SSE 断流 | 同 body 非流式回退 | `21-robust-streambreak.png` + 请求日志 |

## 边界

- 模拟端点只为实现「对标真实 OpenAI 兼容端点」的最小闭环；它不会真的理解语义，内容由 `scenarios.mjs` 确定性生成。
- 运行产物里不含 API Key（模拟 key 为 `sk-sim-v030-local`，仅本地）。
- `results/` 是可重复生成的；报告里的数字以当次运行报告为准。
