# 安全策略

LUMEN 是纯前端应用：没有后端、没有遥测、不加载外链字体，演示数据存在浏览器本地 IndexedDB，模型端点与密钥只在你自己的浏览器设置里。
这让攻击面很小，但并不为零——净化、沙箱、导入解析与导出组装都在浏览器里发生。本文件说明怎么把问题交到维护者手上。

## 支持版本

| 版本 | 是否接收安全修复 |
|---|---|
| 0.2.x（当前主线，`package.json` 为 0.2.5） | 是，随最新补丁版本发布 |
| < 0.2 | 否，建议先升级到最新 0.2.x 再复测 |

只有最新发布版会被评估与修复；主线分支的改动请以最新一次构建产物为准复测。

## 怎么报告

**请勿开公开 issue、公开讨论帖或带 PoC 的 PR。** 私下报告走这一个邮箱：

**<lzytttttt@gmail.com>**

- 邮件标题加前缀 `[SECURITY]`，例如 `[SECURITY] 导出的独立 HTML 在 file:// 下可被 SVG 内联脚本提权`；
- **48 小时内初回**（工作日以 Asia/Shanghai 计），确认收到并给出初步判断；
- 修好之前请不要公开细节、PoC 或截图；
- 是否在发布说明里公开致谢由你决定，默认按「匿名报告者」处理。

报告里请尽量带上：

1. 版本（「设置 → 关于」或 `package.json` 的 `version`）与运行方式（`pnpm dev` / `dist/` 静态托管 / 导出的单文件 HTML 在 `file://` 打开）；
2. 浏览器与操作系统版本；
3. 影响：能读到什么、能写到什么、是否需要用户先做一个动作（打开某个文件、粘贴某段 SVG、导入某个 `.lumen.json`）；
4. 复现步骤或最小 PoC（能贴代码就贴代码，能附导出物就附最小导出物；记得先去掉你自己的密钥与内容）；
5. 你希望的披露时间；没有特别要求就按下面的流程走。

## 处理流程

| 阶段 | 约定 |
|---|---|
| 收到 | 48 小时内初回 |
| 定级 | 7 个工作日内给出影响面判断与是否受理的结论 |
| 修复 | 受理后在主线修复，随下一个补丁版本发布；紧急问题走单独补丁版本 |
| 披露 | 修复版本发布后同步发布说明，写明影响版本与升级建议；报告者可选择是否署名 |
| 协同 | 需要你复测时会在邮件里给出具体构建产物地址或复现步骤 |

## 受理范围

以下方向都欢迎报告，附最小 PoC 最好：

- **SVG / HTML 净化绕过**：`src/render/svg/sanitize.ts`（DOMPurify 3 + 白名单 + 体积上限）的绕过，能让脚本、外链、`foreignObject`、事件属性或危险 URL 穿过；`src/render/blocks/HtmlView.tsx` 的 iframe 沙箱逃逸（逃出 `sandbox="allow-scripts"`、拿到父页面或 IndexedDB、绕开内部 CSP）。
- **XSS 与注入**：deck 字段、幕名 / 备注、图层名、AI 返回内容、replay fixture、图片文件名等任一进入 DOM 的路径上的脚本执行；`innerHTML` / `dangerouslySetInnerHTML` 使用点的转义缺失。
- **导出物注入**：`src/export/standalone.ts` 组装单文件 HTML 时的转义与骨架注入（deck JSON 内联、素材 dataURL、标题与文件名、打印样式），使导出的文件在 `file://` 下执行非预期脚本或外带请求。
- **导入解析**：`.lumen.json`、`.svg`、图片导入路径（`readProjectFileText` → `migrate` → `deckSchema.safeParse`）上的原型污染、超长 / 畸形输入导致的挂起或越权读写。
- **CSP 与响应头**：`vercel.json` 的 `nosniff` / `Referrer-Policy` / `Permissions-Policy` 配置缺失或被绕过；iframe 内联 CSP 的失效路径。
- **本地数据边界**：导入的第三方 deck 能读到不属于它的 IndexedDB 内容、能改写设置里的端点或密钥、能让导出物带上本机密钥。
- **依赖供应链**：`package.json` / `pnpm-lock.yaml` 中被引入的依赖存在已知问题且在本项目里可达的路径（贴出 `pnpm why` 链路更有用）。
- **构建产物一致性**：`public/player/lumen-player.js` 与源码渲染器不一致导致的安全回归。

## 按普通问题处理的情形

这些请走 [Bug 报告](https://github.com/lzytttttt/LUMEN/issues/new?template=bug_report.yml) 或自行处理：

- 需要用户**先**安装恶意浏览器扩展、注入脚本、改 hosts 或已被攻陷的本机环境才能成立的场景；
- 使用者自己填的模型端点返回恶意内容——除非它绕过了净化、沙箱或导出转义，那属于上面的受理范围；
- 托管平台（Vercel、CDN、对象存储）自身的通用问题，以及与本项目配置无关的响应头默认值；
- 对他人部署实例的压测、扫描、DoS 与暴力枚举（本项目没有后端，这类请求落在托管方）；
- 旧版本（< 0.2）上的问题、已经在最新版修掉的问题；
- 社交工程、钓鱼邮件、冒充维护者；
- 浏览器 / 操作系统的 0day 与本项目无关的部分；
- 内容层面的版权、商标与授权争议（走 <lzytttttt@gmail.com> 的普通邮件，不走安全流程）。

## 现有安全设计（事实）

了解这些能让报告更聚焦：

| 环节 | 现状 |
|---|---|
| 数据流 | 无后端、无遥测、无远程字体；演示与设置只在本地 IndexedDB（单库 `lumen-deck`） |
| 密钥 | 模型端点与密钥只存在浏览器本地设置里；导出的 `.lumen.json` 与独立 HTML 都不含端点与密钥 |
| SVG | 唯一净化入口 `src/render/svg/sanitize.ts`（DOMPurify 白名单 + 字节上限），所有插入路径（工具栏、拖拽、AI 生成、工作室）共用它 |
| HTML 块 | `sandbox="allow-scripts"` 的 iframe，**没有** `allow-same-origin`，并在文档内加 `meta` CSP |
| 导入 | `.lumen.json` 经 `readProjectFileText` → `migrate` → `deckSchema.safeParse`（zod）；播放器内核读取内联 deck 时同样过 `safeParse` |
| 导出 | 单文件 HTML 的标题、文件名、deck JSON、素材 dataURL、打印样式统一走 `src/export/standalone.ts` 的转义与骨架；超过 12MB 提示、超过 24MB 中止产出 |
| 响应头 | `vercel.json` 下发 `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`（相机 / 麦克风 / 定位全关） |
| 依赖 | 版本由 `package.json` 钉住，`pnpm-lock.yaml` 入库；Vercel 用 `pnpm install --frozen-lockfile` 构建 |

## 使用者侧的三个习惯

1. 只打开**自己导出**或**来源可信**的独立 HTML——它和编辑器同源同内核，等于在 `file://` 下跑一份完整的演示应用；
2. 导入别人给的 `.lumen.json` 前，先在无害环境里打开一次，别在存着敏感演示的浏览器配置里直接导入；
3. 升级依赖后跑一遍 `pnpm install --frozen-lockfile` 与 `pnpm test`，让 lockfile 与构建保持一致。

## 致谢

受理并修复的问题会记在发布说明的 Security 段；默认匿名，愿意署名请直接在邮件里写明希望使用的名字与链接。
