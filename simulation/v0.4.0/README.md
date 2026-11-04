# v0.4.0 · 创造模式模拟全链路实战成果

> 这一份是**运行结果**目录。可重复执行：
> `node simulation/v0.4.0/mock-creator-server.mjs --selftest` → `node simulation/v0.4.0/run-simulation.mjs --preview`
> 完整可视化报告：**[`results/report.html`](results/report.html)**（含全部截图）· 机器可读：`results/report.json`。

## 结论（最后一次运行）

| 指标 | 值 |
|---|---|
| 步骤 | **10 / 10 通过**，0 失败 |
| 断言 | **27 条** |
| 创造模式请求 | **1 次**（`task=plugin` · `intent=theme` · SSE 流式） |
| 模拟端点 | `http://127.0.0.1:5299/v1` · `lumen-sim-plugin-0.4`（严格 JSON + SSE） |
| 页面 | `http://127.0.0.1:5277`（`vite preview`，零 HMR 干扰） |
| 总耗时 | 约 **14.1s**（含构建/静态服务启动、设置、安装、全链路与刷新恢复） |
| 截图 | **7 张** |
| console error / page error / 失败请求 | 0 / 0 / 0 |
| 端点契约自测 | **9 / 9 PASS**（`--selftest`，无需浏览器） |

## 覆盖到的路径

| # | 场景 | 证据 |
|---|---|---|
| 1 | 设置切到模拟 OpenAI 兼容端点并测连通性 | `01-settings-connected.png`、`llm/requests.jsonl` |
| 2 | 插件页安装三款内置样例（走真实安装管线；样例默认不启用） | `02-plugin-manager-installed.png` |
| 3 | 顶栏 `✦ 创造` 打开面板（`html[data-lumen-creator="1"]`，idle） | `03-creator-proposal.png` 前的面板态 |
| 4 | 一句话 → `plugin` 任务（HTTP+SSE）→ 提案卡：文件树/diff/权限 chips | `03-creator-proposal.png` |
| 5 | 试跑：默认只读（无 `deck:write`，`data-creator-deck-writes` 不出现，草稿不计入 `data-lumen-plugins`） | `04-creator-trial.png` |
| 6 | 撤销改造：终态 `applied + outcome=reverted`，舞台文本与试跑前一致 | `05-creator-reverted.png` |
| 7 | 再试跑 → 保留：走安装管线并启用（`applied + outcome=saved`，`data-lumen-plugins` 0→1） | `06-creator-saved.png` |
| 8 | 刷新恢复：不自动重挂试跑，终态 `saved` + `data-creator-restored="1"` | `07-creator-resumed.png` |
| 9 | 浏览器干净度：0 console error / 0 page error / 0 失败请求 | `browser/*.json` |
| 10 | 端点契约：请求全部 `task=plugin`、SSE 流式、提案可解析 | `llm/requests.jsonl` + `--selftest` |

## 文件

```
simulation/v0.4.0/
├── mock-creator-server.mjs   # 零依赖模拟端点：OpenAI 兼容 + SSE，只服务 [TASK:plugin]，按 intent 返回 fixture 提案；--selftest 9 项
├── run-simulation.mjs        # Playwright 驱动（10 步）：preview 构建 → 安装样例 → 创造模式提案 → 试跑 → 撤销 → 再试跑 → 保留 → 刷新恢复
├── README.md                 # 本文件
└── results/
    ├── report.html           # 可视化报告（先看这个）
    ├── report.md / report.json
    ├── run.log               # 逐步日志（含 dev/build 输出）
    ├── screenshots/          # 7 张证据截图
    ├── llm/                  # requests.jsonl（只记长度/任务/意图，不落用户原文）+ requests.pretty.json
    └── browser/              # console / page-error / failed-request 分类
```

## 复现

```powershell
# 1) 端点契约（自起自停，不占浏览器）
node simulation/v0.4.0/mock-creator-server.mjs --selftest

# 2) 全链路（默认 --preview：先 build 再 vite preview，零 HMR，避免并行开发触发的整页重载）
node simulation/v0.4.0/run-simulation.mjs --preview

# 也可以对 dev server 跑（复用 5273；没有则自己起 5276；不抢 qa 的 5274）
node simulation/v0.4.0/run-simulation.mjs --base http://127.0.0.1:5273
```

## 本次运行修掉的真问题（已回写 src/creator）

- `reverted` 终态点「再试一次」原先不会转移到 `trialing`（reducer 的 `trial.start` 只允许 `proposal-ready`），
  导致「试跑 → 撤销 → 再试跑 → 保留」链路断在第二步；现在 `reverted` 也可再次试跑（04 §3.2 结果卡主按钮语义）。

## 边界

- 模拟端点是确定性样张生成器：它验证的是**管线、契约、状态机、UI 钩子与刷新恢复**，不代表真实模型能力。
- 证据里不含 API Key（模拟 key 为 `sk-sim-v040-local`，仅本地）与用户一句话原文（请求日志只记长度/意图）。
- `results/` 可重复生成；报告里的数字以当次运行报告为准。
