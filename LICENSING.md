# 许可与合规 / Licensing

> 一句话：**源码按「Apache-2.0 + Commons Clause」或「FSL-1.1-MIT」二选一授权；设计资产、示例文案与品牌标识另按 CC BY-NC 4.0 / 商标规则处理；商业转售需单独授权。**

本文件解释仓库里各个部分的许可边界。法律效力以根目录 [`LICENSE`](LICENSE)、[`LICENSE-FSL-1.1-MIT.md`](LICENSE-FSL-1.1-MIT.md)、[`LICENSE-CC-BY-NC-4.0.txt`](LICENSE-CC-BY-NC-4.0.txt) 的原文为准；本文件是导读，不替代原文。

## 1. 为什么从 CC BY-NC 4.0 迁移

`v0.2.0` 及更早版本使用 Creative Commons `CC BY-NC 4.0`。Creative Commons 官方明确不建议把 CC 协议用于软件源码：它没有专利授权条款，与主流软件许可证（Apache-2.0、MIT、GPL）不兼容，也无法处理“分发编译产物 / 链接 / 专利”等软件场景。

从 `v0.2.5` 起，源码迁移到两条 source-available 路径：

| 路径 | 文件 | 适合谁 | 关键限制 |
| :--- | :--- | :--- | :--- |
| **默认：Apache-2.0 + Commons Clause** | [`LICENSE`](LICENSE) | 绝大多数使用者：自建、内部工具、教学、二次开发、插件 | 保留 Apache-2.0 的全部自由（含专利授权），但**不得转售本软件本身**或其等价物 |
| **备选：FSL-1.1-MIT** | [`LICENSE-FSL-1.1-MIT.md`](LICENSE-FSL-1.1-MIT.md) | 需要“两年后自动转 MIT”这一确定性承诺的团队 | 两年内不得做与本软件竞争的商业产品；满两年后该版本自动转为 MIT |

两条路径是**二选一**（dual-track，at your option），不是叠加：对同一次使用，选定一条并遵守它即可。项目自身发布的版本、官网演示与 Vercel 部署按默认路径（Apache-2.0 + Commons Clause）分发。

### 该选哪条？

- 你要把它嵌进自己的商业产品、内部平台、课程或客户交付，但不转售 LUMEN 本身 → **默认路径**。
- 你是一家公司，法务只接受“有明确日期转为 MIT/Apache-2.0”的源码许可 → **FSL-1.1-MIT**。
- 你要把 LUMEN 改名后作为竞品/SaaS 出售，或把源码打包成付费产品 → 两条路径都不允许，请走[商业授权](#5-商业授权)。
- 你要给 LUMEN 提交补丁 → 见[贡献](#6-贡献-inboundoutbound)。

## 2. 适用范围矩阵

| 路径 / 内容 | 许可 | 说明 |
| :--- | :--- | :--- |
| `src/**`、`scripts/**`、`api/**`、`tests/**`、根目录构建配置（`vite*.config.ts`、`tsconfig.json`、`package.json`、`playwright.config.ts`、`vitest.config.ts` 等） | Apache-2.0 + Commons Clause（或 FSL-1.1-MIT，二选一） | 软件源码与构建脚本 |
| `public/player/**` | 同源码 | 由 `src/player` 构建出的播放器内核，属于软件产物 |
| `doc/**`（除图片）、`README*.md`、`CHANGELOG.md`、`LICENSING.md`、`CONTRIBUTING.md`、`SECURITY.md` | 同源码 | 文档随源码授权；引用第三方内容时以第三方许可为准 |
| `doc/screenshots/**`、`doc/*.png`、`public/icons/**` 中的品牌图 | **CC BY-NC 4.0** | 截图、品牌视觉、宣传图：可署名非商业分享，不可商业使用 |
| `src/sample/sample-deck.ts`、`src/fixtures/**`、`src/ai/corpus.ts`、`src/ai/recipes.ts` 中的示例文案与模板内容 | **CC BY-NC 4.0** | 代码结构仍按源码许可；其中的示例文案/模板内容不可直接用于商业交付，商用请替换为你自己的内容 |
| `LUMEN` / `幕光` 名称、Logo、品牌视觉 | **保留商标权** | 见 [`TRADEMARK.md`](TRADEMARK.md)；Apache-2.0 §6 不授予商标许可 |
| `node_modules/**` 与打包进播放器的第三方库 | **各自原许可** | 见 [`NOTICE`](NOTICE)；我们不改变、也无法改变这些许可 |

> 判断规则：**能编译、能运行、能改的 → 源码许可；看得见的设计资产与示例文案 → CC BY-NC；名字与 Logo → 商标。**
> 如果某个文件头部自带许可声明，以该声明为准。

## 3. 默认路径：Apache-2.0 + Commons Clause 到底允许什么

Commons Clause 只在 Apache-2.0 之上加了一条限制：**不得“Sell the Software”**。它不限制：

- 自建、私有部署、内部使用、公司内部培训；
- 修改源码、做衍生作品、内部再分发；
- 把 LUMEN 嵌入更大的产品（只要你卖的是那个更大的产品，而不是 LUMEN 本身）；
- 用 LUMEN 提供咨询、实施、定制开发服务；
- 学术研究、非商业教学、开源项目集成；
- 专利授权（Apache-2.0 §3）仍然有效。

它限制的是：把 LUMEN（或仅改名的等价物）本身作为付费产品、付费 SaaS、付费模板包出售，或提供其托管服务并收费。

Commons Clause 不是 OSI 认可的开源许可，因此请把本项目描述为 **source-available（源码可用）**，不要称为 “open source”。这也是 `package.json` 里 `license` 字段写作 `SEE LICENSE IN LICENSE` 的原因：SPDX 没有 `Apache-2.0 WITH Commons-Clause` 这样的标准表达式。

## 4. 备选路径：FSL-1.1-MIT

FSL 由 Sentry 起草，属于 [Fair Source](https://fair.io/) 运动：

- 允许内部使用、非商业教育/研究、以及围绕软件的 professional services；
- 禁止把软件做成替代品或实质相同功能的商业产品（Competing Use）；
- **每个版本在发布满两年后，自动获得 MIT 许可**（不可撤销）。

如果你的合规流程需要“某一天之后确定变成 OSI 开源”，选这条；如果你需要永久阻止“改名转售”，选默认路径。二者不可同时主张。

## 5. 商业授权

需要以下任一场景，请邮件联系 **lzytttttt@gmail.com**（标题注明 `LUMEN Commercial License`）：

- 转售 LUMEN 本身、以 LUMEN 为核心提供付费 SaaS/托管；
- 将示例文案、模板、截图用于商业交付；
- 使用 LUMEN 名称与 Logo 做商业宣传；
- 需要书面保证、 indemnity、专属条款或私有分支。

商业授权不影响已按 Apache-2.0 + Commons Clause 发布的版本：已经授予你的权利不会被撤回。

## 6. 贡献（inbound=outbound）

- 提交 PR 即表示你同意：你的贡献按本仓库当前的源码许可（Apache-2.0 + Commons Clause，并允许维护者按 FSL-1.1-MIT 备选路径再许可）授权给本项目与所有下游使用者。
- 不需要签署 CLA；请用 `git commit -s` 添加 Developer Certificate of Origin（DCO）签名，表示你有权提交该代码。
- 不要提交来源不明、许可不兼容（如 GPL/AGPL 代码、闭源素材、未授权的字体/图片）的内容。
- 详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 7. 署名示例

```text
LUMEN / 幕光 by 无极Ayaya — https://github.com/lzytttttt/LUMEN
Licensed under the Apache License 2.0 with the Commons Clause License Condition v1.0.
Design assets and sample copy: CC BY-NC 4.0. "LUMEN" and the logo are trademarks of the author.
```

## 8. 版本与再许可记录

| 版本 | 日期 | 许可 |
| :--- | :--- | :--- |
| `v0.2.0` 及更早 | 2026-10-28 及以前 | CC BY-NC 4.0（历史版本保持原许可，不追溯变更） |
| `v0.2.5` 起 | 2026-10-29 | Apache-2.0 + Commons Clause；备选 FSL-1.1-MIT；资产 CC BY-NC 4.0 |

> 许可变更只对变更之后发布的版本生效；已经按旧许可获得的副本，其权利不受影响。
