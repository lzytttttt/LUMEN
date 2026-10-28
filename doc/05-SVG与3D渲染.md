# 05 SVG 与 3D 渲染 —— 实现契约

> 本文只写**实现事实与接口契约**：渲染层怎么被调用、descriptor 怎么变成画面、SVG/HTML 的安全边界、lint 的稳定 code 与阈值。
> 产品主张、设计原则、路线图见 `doc/01-产品概述.md`；所有权与命令见 `doc/00-工程契约.md`。
> 归属：`src/render/**`（含 `slide.css`、`svg/**`、`three/**`、`blocks/**`）与 `src/lint/**`。

## 1. 渲染契约

### 1.1 SlideRenderer props（保持不变）

```tsx
<SlideRenderer
  deck={deck}                 // Deck：主题、locale、slides
  slide={slide}               // 当前这一幕
  mode="stage"                // 'stage' | 'play' | 'thumb' | 'print' | 'export'，默认 stage
  active                      // 该幕是否"在台上"，默认 true；播放态用来启停 3D/动效
  theme?                      // 覆盖主题（面板预览用），缺省 getTheme(deck.themeId)
  editingBlockId?             // 编辑器中正在内联编辑的块，只有它吃指针事件
  className? / style?         // 只作用于根节点
/>
```

- 根节点固定 `1600 × 900`，**不**自己缩放；调用方负责 `transform: scale()` + `transform-origin: top left`。
- 主题通过 `themeCssVars(theme, deck.themeOverrides)` 注入 `--d-*` 变量；3D 取色用同一份合并色（`{...theme.colors, ...deck.themeOverrides}`），保证 CSS 与 WebGL 同源。
- 隐藏块（`hidden`）在渲染前被过滤，按 `z` 升序绘制。

### 1.2 mode 语义表

| 能力 | `stage` | `play` | `thumb` | `print` / `export` |
|---|---|---|---|---|
| three 运行时 | 建（当前幕） | 随 `active` 启停 | **绝不创建** | 建，只渲一帧后停住 |
| 3D 动画循环 | 开 | `active` 时开 | 无 | 关 |
| SVG `float/pulse/spinSlow` | 关 | 开 | 关 | 关 |
| SVG `draw` 描边生长 | 关 | 开（非 reduced-motion） | 关 | 关 |
| HTML iframe | 挂载 | 挂载 | **不挂载** | 挂载 |
| 入场动效（`enter`） | 关 | 开 | 关 | 关 |
| 图片骨架呼吸 | 开 | 关 | 关（CSS 统一关动画） | 关 |
| SVG issue 角标 | 显示 | 不显示 | 不显示 | 不显示 |

### 1.3 坐标系与缩放分工

- 所有几何量都是**设计像素**：`x/y/w/h/rotation/strokeWidth/fontSize` 一律以 1600×900 为基准。
- 缩放只在最外层做一次：编辑器 `.stage-frame`、播放 `.play-stage`、幕栏缩略图 `.rail__canvas`。渲染层内部不再二次换算。
- three 的后备缓冲用**设计像素 × pixelRatio**，与 CSS 尺寸解耦：canvas CSS 恒为 `100% × 100%`，`renderer.setSize(w, h, false)` 只改后备缓冲。

### 1.4 pointer-events 策略

命中测试的唯一真相在 `Stage` 的几何层，渲染内容默认不吃事件：

```css
.lumen-slide[data-mode='stage'] .lumen-block { pointer-events: none; }
.lumen-slide[data-mode='stage'] .lumen-block[data-editing='true'],
.lumen-slide[data-mode='stage'] .lumen-html iframe,
.lumen-slide[data-mode='stage'] .lumen-three[data-interactive='true'] canvas { pointer-events: auto; }
```

- `play / thumb / print / export` 不施加上述限制（播放器需要 HTML 块可交互）。
- 只有 `editingBlockId` 对应的块可以接收指针事件（内联改字）。

### 1.5 DOM 属性契约

| 节点 | 属性 | 用途 |
|---|---|---|
| `.lumen-slide` | `data-mode` `data-slide-id` `data-bg` `data-theme` | 模式样式、调试、截图定位 |
| `.lumen-block` | `data-block-id` `data-block-type` `data-enter` `data-locked` `data-editing` `data-mode` | 命中层与动效选择器 |
| `.lumen-three` | `data-three-state`(`idle`/`live`/`fallback`) `data-three-preset` `data-interactive` | 3D 状态与降级样式 |
| `.lumen-three__fallback` | `data-three-placeholder="true"` | 降级视图标记（真实渲染时不出现） |
| `.lumen-svg` | `data-mode` `data-animate` `data-viewbox` `data-aspect` `data-issues` | 动效选择器与诊断 |
| `.lumen-html` | `data-height-mode`(`block`/`content`) | 高度策略 |
| `.lumen-image` | `data-fit`(`cover`/`contain`) `data-image-state`(`empty`/`false`/`true`) | 图片三态样式 |

## 2. three 运行时

### 2.1 模块边界与动态加载

```
blocks/ThreeView.tsx  ──静态──▶  three/runtime.ts  ──动态──▶  import('three')
                                        │                          └─ 主包不含 three 源码
                                        └──静态（只 import type）──▶ three/sceneBuilder.ts
                                                                     └─ 动态 import RoomEnvironment
```

- `runtime.ts` / `sceneBuilder.ts` 对 three 一律 `import type`，运行期 `import('three')` 由 Vite 拆成独立 chunk。
- 加载失败会缓存 `null`（本次会话不再重试），调用方走降级视图；刷新页面即恢复。
- `loadThreeModule()` 可单独调用（测试、探针用），返回 `Promise<typeof import('three') | null>`。

### 2.2 descriptor → scene 映射

`ThreeDescriptor`（`src/schema/deck.ts` 的 `threeDescriptorSchema`）是唯一输入，全部字段有默认值。

| 字段 | 取值 | 映射到 |
|---|---|---|
| `preset` | `orbit` `showcase` `wave-field` `particle-cloud` `torus` `stack` `globe` | `objects` 为空时的默认构图（见 2.3） |
| `objects` | `shape/material/tint/scale/pos/rot/metalness?/roughness?` × ≤24 | 非空时**以其为准**，preset 不叠加默认构图 |
| `palette` | `accent` `mono` `duotone` | 主题色 → 四色语义（见 2.4） |
| `light` | `studio` `sunset` `neon` `soft` | 灯光组（见 2.6） |
| `bg` | `transparent` `theme` `void` | renderer 清除色：`alpha 0` / `colors.bg` / `#05060a` |
| `camera` | `distance 1.6–24` `elevation -0.9–1.1(rad)` `fov 18–80` | `position = (0, sin(el)·d, cos(el)·d)`，`lookAt(0,0,0)` |
| `motion` | `rotate/float/pulse/none` + `speed 0–2` | 全局运动（见 2.5） |
| `grain` | `0–1` | CSS 噪点层透明度（不做后处理通道） |
| `orbitControls` | `boolean` | 仅写入 `data-interactive`，交互本身未实现（见 §6） |

### 2.3 7 个预设构图

| preset | 构图 |
|---|---|
| `orbit` | 主环 Torus(1.72/0.045) + 线框外环(2.02) + 内核 Icosahedron(0.6) + 3 颗轨道卫星（半径 1.95/2.07/2.19，各自相位） |
| `showcase` | 展台 Cylinder(1.62→1.78, h 0.16) + 主体 TorusKnot(0.56/0.16) + 台面光环(1.34) |
| `wave-field` | 9×9 方格 Box(0.28)，间距 0.44，`y = sin(x·1.55 + t·1.5) + cos(z·1.25 − t·1.15)`，逐列换色 |
| `particle-cloud` | Points 1600 点（球壳分布，半径 0.9–2.4）+ 极淡球壳线框(1.62, opacity 0.14) |
| `torus` | 主体 Torus(1.2/0.32) + 内环(0.72) + 线框外环(1.78) + 环上珠子(0.11) |
| `stack` | 5 层错位 Box（2.1→0.4 递减，含 standard/physical/toon 三种材质） |
| `globe` | 线框球(1.28, opacity 0.3) + 球面点云 900 点 + 赤道环(1.62) + 轨道标记球(0.1) |

- 所有几何单位都在 ~2 单位量级，最终由「构图自适应」统一缩放（见 2.7）。
- 粒子构图用固定种子的 LCG 采样，**每次重建完全一致**（截图可复现）。

### 2.4 材质与调色板

| material | three 类 | 关键参数 |
|---|---|---|
| `standard` | `MeshStandardMaterial` | `metalness`(0.42) `roughness`(0.34)，`icosa/octa/cone` 开 `flatShading` |
| `physical` | `MeshPhysicalMaterial` | `metalness`(0.55) `roughness`(0.16) `clearcoat`(0.85) `envMapIntensity`(1.15) |
| `toon` | `MeshToonMaterial` | 3 阶 gradientMap（`DataTexture([72,158,255], 3×1, RedFormat)`，Nearest） |
| `wireframe` | `MeshBasicMaterial` | `wireframe: true` `transparent` `depthWrite: false`，默认 opacity 0.86 |

`physical` 的 IBL：`RoomEnvironment` → `PMREMGenerator.fromScene(room, 0.04)` → `scene.environment`；render target 与 generator 都登记进资源袋统一释放。环境贴图生成失败只降级高光，不阻断渲染。

调色板 → 四色语义（`resolvePalette`）：

| palette | primary | secondary | accent | ink（结构件） |
|---|---|---|---|---|
| `accent` | `colors.accent` | `colors.accent2` | `colors.accent2` | `colors.muted` |
| `mono` | `colors.fg` | `colors.muted` | `colors.line` | `colors.surface` |
| `duotone` | `colors.accent` | `colors.accent2` | `colors.accent2` | `colors.surface` |

`objects[].tint` 再按 palette 折回（`tintColor`）：`mono` 把 accent/accent2 折到 fg/muted；`duotone` 把 fg/surface 折到 accent、muted 折到 accent2。主题色若不是合法 CSS 色值，`safeColorValue` 回退到默认色，避免 three 打警告。

### 2.5 运动

全局运动只作用于 `root`（构图中心），预设动画只动子节点，互不覆盖：

| kind | 效果 |
|---|---|
| `rotate` | `root.rotation.y = t · speed · 0.55` |
| `float` | `root.position.y = sin(t·(0.7+speed))·0.16`，`rotation.y = t·speed·0.22` |
| `pulse` | `root.scale = 1 + sin(t·(1.3+speed))·0.03`，`rotation.y = t·speed·0.25` |
| `none` | 静止（预设动画回调也不执行） |

- 预设动画与 objects 自转的回调都拿 `(elapsed 秒, speed)`，内部用 `clock = elapsed · speed` 计时。
- `speed = 0` 等价冻结在 t=0 的构图。

### 2.6 4 套灯光

光源位置统一乘 `s = camera.distance / 7`，不同 distance 下曝光一致。

| light | 组成 |
|---|---|
| `studio` | Hemi(白/`#14141a`,0.62) + Key 白 2.35 + Fill `palette.secondary` 1.05 + Rim `palette.primary` 1.4 |
| `sunset` | Hemi(`#ffc7a1`/`#2a1620`,0.55) + Key `#ff9a52` 3.1 + Fill `#6f7dff` 1.1 + Rim `#ffd0a0` 0.8 |
| `neon` | Ambient `#1a2340` 1.1 + Point `palette.primary` 34·s² + Point `palette.secondary` 26·s² + 白 Directional 0.42 |
| `soft` | Hemi(白/`#9aa0aa`,1.05) + 白 Directional 1.15 + Ambient 白 0.42 |

### 2.7 相机与构图自适应

- `PerspectiveCamera(fov, aspect, near 0.1, far 400)`，`position = (0, sin(elevation)·distance, cos(elevation)·distance)`。
- 构图建好后做一次「包围盒居中 + 缩放」：`radius = max(size)/2`，`limit = min(halfW, halfH) · 0.92`，其中 `halfH = tan(fov/2)·|position|`、`halfW = halfH·aspect`；只有 `radius > limit` 才缩小。
- 结果写进 `fit` 组（`scale` + `position = −center · scale`），`root → fit → content` 三层：`root` 负责运动、`fit` 负责居中缩放、`content` 是预设内容。

### 2.8 背景与 grain

- `renderer.setClearColor(color, alpha)`：`transparent → (0,0,0,0)`、`theme → colors.bg`、`void → #05060a`。
- `renderer.outputColorSpace = SRGBColorSpace`、`toneMapping = ACESFilmic`、`toneMappingExposure = 1.06`。
- grain 是一层 CSS 噪点（`feTurbulence` data-URI + `mix-blend-mode: overlay` + 径向遮罩淡出四边），按 `descriptor.grain` 设透明度；**不引入后处理通道**。

### 2.9 生命周期与预算

```
createThreeRuntime({ canvas, descriptor, colors, pixelRatioCap?, key?, width?, height?, onSuspend?, onError? })
  → Promise<ThreeRuntime | null>
```

| 阶段 | 行为 |
|---|---|
| 创建前 | `isWebGLAvailable()` 探测（`WebGLRenderingContext` 不存在直接 false，探测上下文立即 `loseContext`）；同 `key` 先释放旧实例 |
| 预算 | 模块级注册表，同时存活 ≤ `MAX_LIVE_THREE_RUNTIMES = 4`；超出时把**最久未用**的挑出来：先 `capture()` 出 PNG，再 `dispose()`，最后回调 `onSuspend(poster)` |
| renderer | `antialias: true`、`alpha: true`、`preserveDrawingBuffer: true`、`powerPreference: 'high-performance'` |
| pixelRatio | `min(devicePixelRatio, cap(默认 2), sqrt(4.2M / (w·h)))`，下限 0.5（`MAX_BACKING_PIXELS` 防止大块 3D 拖垮滚动） |
| 运行 | `setActive(true)` 开 `setAnimationLoop`；`setActive(false)` 停循环并补最后一帧 |
| 尺寸 | `resize(w,h)` 只改后备缓冲 + `camera.aspect`，不重建上下文 |
| 释放 | 停循环 → 解绑 `webglcontextlost` → 释放 geometry/material/texture/renderTarget → `renderer.dispose()` → `renderer.forceContextLoss()`；`dispose()` 幂等 |
| 异常 | 上下文丢失：`preventDefault()` + `failed = true` + 停循环 + `onError('context-lost')`；初始化异常 → `onError('init-failed')` 且返回 null |

`ThreeRuntime` 接口：

```ts
interface ThreeRuntime {
  setActive(active: boolean): void
  resize(width: number, height: number): void
  renderOnce(): void
  capture(): string | null      // dataURL(png)
  dispose(): void
  readonly failed: boolean
}
```

### 2.10 失败与降级

`ThreeView` 的状态机：`idle → live`，任何失败/淘汰进 `fallback`。

降级视图内容优先序：运行时截下的 poster → 幕栏缓存（见 2.12）→ `block.posterAssetId` 对应的图 → 主题渐变 + `3D · {preset}` + `{palette} / {light}`。

触发 `fallback` 的情形：WebGL 不可用、`three` 加载失败、初始化抛错、`webglcontextlost`、预算淘汰、`mode='thumb'`。

### 2.11 取帧 / 释放 API（给 exporter）

```ts
import { captureThreeFrame, disposeAllThreeRuntimes, suspendThreeRuntime } from '@/render/three/runtime'
// 或统一从 '@/render/three' 取
```

| API | 语义 |
|---|---|
| `captureThreeFrame(key?)` | 传 blockId 取该块当前帧（内部先 `renderOnce` 再 `toDataURL('image/png')`）；不传 key 取最近使用的一个；没有存活实例返回 `null` |
| `suspendThreeRuntime(key)` | 立刻截图并挂起该 runtime（切走一幕、导出结束用）；返回是否命中 |
| `disposeAllThreeRuntimes()` | 全部释放并归还上下文 |
| `getLiveThreeRuntimeCount()` | 当前存活数量（调试/预算断言） |
| `isWebGLAvailable()` | 能力探测（带缓存） |

导出约定：
1. 把目标块以 `mode='export'`（或 `'print'`）渲染并保持挂载，等 `data-three-state="live"`；
2. `captureThreeFrame(blockId)` 拿 PNG，写进海报/HTML；
3. 导出结束调 `disposeAllThreeRuntimes()`。
即：**渲染层不主动把帧塞进 deck**，取帧是导出层的事。

### 2.12 海报缓存（缩略图）

`three/posterCache.ts` 是缩略图的桥：

- `ThreeView` 在 `live` 之后约 620ms 抓一帧写入缓存（只抓一次），被预算淘汰时也会把 poster 写进去。
- 幕栏缩略图通过 `useSyncExternalStore(subscribeThreePosters, () => getThreePoster(blockId))` 订阅，拿到就画 `<img>`（本地 dataURL，不发外部请求）。
- 上限 `MAX_ENTRIES = 32`（LRU），`clearThreePosters()` 可整体清空。

## 3. SVG

### 3.1 唯一入口

`src/render/svg/sanitize.ts` 的 `sanitizeSvgDocument(source, { maxBytes? }) → { svg, issues, changed }` 是 SVG 进入 DOM 的**唯一**入口；渲染层只做字符串级外壳补齐（`svg/frame.ts`），不做第二次 DOM 注入，`dangerouslySetInnerHTML` 的内容必须来自它。

### 3.2 标签白名单

允许：`svg g defs symbol use title desc path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask filter feGaussianBlur feOffset feMerge feMergeNode feColorMatrix feBlend marker pattern text tspan`

禁止（连同内容一起丢弃）：`script foreignObject iframe object embed audio video canvas animate animateTransform animateMotion set a image style`

> 白名单是「结构」层，DOMPurify 先跑一遍 `svg + svgFilters` profile，再逐节点做上面的白名单与属性策略；被剔除的条目逐条进 `issues`，UI 用数量角标展示。

### 3.3 属性策略

| 规则 | 处理 |
|---|---|
| `on*` 事件属性 | 删除并记 issue |
| `href` / `xlink:href` | 只允许同文档 `#id`，其余删除 |
| 内联 `style` | 一律删除（样式必须走属性 + 主题令牌） |
| 颜色属性（`fill/stroke/stop-color/flood-color/color`） | 只允许 `none / currentColor / transparent / var(--d-*) / #hex / rgb() / hsl() / url(#id)`；其它改写为 `var(--d-accent)` 并记 issue |
| 外部 `url(http…)` | 删除（含 `url(https://…)` 形式的 paint 引用） |
| `viewBox` 缺失 | 有 `width/height` 就按它补，否则补 `0 0 1600 900` |
| `preserveAspectRatio` | 强制 `xMidYMid meet`（等比完整显示，不裁切） |
| 体积 | 超过 512KB（`MAX_SVG_BYTES`）直接拒绝渲染并记 `size` issue |

> 本地 paint 引用（`url(#gradient)`）是合法颜色，不能当非法色改写——示例第 3 幕的渐变卡就依赖这条。

### 3.4 viewBox / preserveAspectRatio

- `sanitizeSvgDocument` 保证有 viewBox；`ensureSvgFrame(markup, block.viewBox)` 再做一次字符串级兜底（块自身的 `viewBox` 作为回退值）。
- 宽高比不一致时由 `preserveAspectRatio="xMidYMid meet"` 决定留白，渲染层不拉伸。
- 块上会带 `data-viewbox` / `data-aspect`，方便排查「为什么有留白」。

### 3.5 动画

| `animate` | 生效模式 | 实现 |
|---|---|---|
| `none` | — | 不做任何事 |
| `float` | `play` | CSS `lumen-float`（7s，±14px） |
| `pulse` | `play` | CSS `lumen-pulse`（5.6s，scale 1→1.025 + 透明度） |
| `spinSlow` | `play` | CSS `lumen-spin`（26s 线性） |
| `draw` | `play` | JS：逐条 `<path>` 描边生长（见下） |

`draw` 实现要点（`svg/draw.ts`）：

1. `host.querySelector('svg')` 后取全部 `path`，逐条 `getTotalLength()`；拿不到长度（jsdom/异常）就跳过。
2. 记下作者原本的 `stroke-dasharray` / `stroke-dashoffset`，然后设 `dasharray = L L`、`dashoffset = L`。
3. 用 Web Animations API 从 `dashoffset: L → 0`，时长 900ms，`cubic-bezier(.32,.72,0,1)`，相邻路径错峰 `min(120, 420/(n−1))` ms。
4. 全部 `onfinish` 后把原始属性还原；`cleanup` 取消动画并立即还原，可重复调用。
5. `prefers-reduced-motion: reduce` 时整段跳过（内容本来就完整可见）；非 `play` 模式不运行。

### 3.6 净化角标

`sanitizeSvgDocument` 返回的 `issues` 数量以 `.lumen-svg__badge` 显示在块右上角，**仅 `mode='stage'`**、样式克制（10px 等宽、低透明度），`title` 里带前 4 条明细。悬停不拦截指针事件。

## 4. HTML 沙箱

### 4.1 文档外壳与 CSP

`composeHtmlDoc(block, { measure? })` 生成完整文档，CSP 固定为：

```
default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:
```

即：默认禁止一切网络请求，只允许内联样式/脚本与 data/blob 资源；不加载外链字体、不请求远端图片。

### 4.2 sandbox

- `sandbox="allow-scripts"`（**没有** `allow-same-origin`）：脚本拿不到父页 DOM、Cookie、IndexedDB，来源是 opaque origin。
- 附加 `loading="lazy"`、`referrerPolicy="no-referrer"`。
- CSP 与 sandbox 都**不要放宽**；需要新能力先走 Lead。

### 4.3 heightMode 与测高协议

- `heightMode='block'`（默认）：iframe 铺满块高。
- `heightMode='content'`：注入测高脚本，iframe 高度跟随内容（容器 `overflow: visible`，最多放宽到块高的 4 倍，防脚本失控）。
- 消息格式：`{ type: 'lumen:height', height: number }`（`HTML_HEIGHT_MESSAGE = 'lumen:height'`）。
- 父页校验顺序（缺一不可）：
  1. `event.source === iframe.contentWindow`（唯一可信来源，其它来源一律忽略）；
  2. `event.data` 是对象且 `type === 'lumen:height'`；
  3. `height` 是有限正数，然后 `Math.min(height, block.h * 4)`。
- `mode='thumb'` 不挂载 iframe，只渲染 `HTML` 占位。

## 5. deck lint

### 5.1 API

```ts
import { lintDeck, summarizeLint, LINT_CODES, LINT_LIMITS } from '@/lint/deckLint'  // 或 '@/lint'

type LintSeverity = 'info' | 'warn' | 'error'
interface LintIssue {
  code: string                                  // 稳定短标识，不是文案
  severity: LintSeverity
  slideId?: string
  blockId?: string
  params?: Record<string, string | number>       // 已四舍五入，可直接插值
}
lintDeck(deck, opts?: { theme?: Theme }): LintIssue[]
summarizeLint(issues): { info: number; warn: number; error: number }
```

- 纯函数、同步、无 DOM 副作用；canvas 测量上下文惰性创建并缓存，jsdom（无 canvas）下自动退到字符宽度系数，不报错。
- 输出顺序：先 deck 级（`slideCount`、`threeBudget`），再按幕序 + 块序。
- 阈值集中在 `LINT_LIMITS`，改阈值只改一处。

### 5.2 code 全集与规则

| code | 判定 | 阈值 |
|---|---|---|
| `textOverflow` | `measureText` 估算的行数/宽度与实际块尺寸之比 | `ratio > 1.06` 才报；`> 1.25` 升 error |
| `contrast` | 文本色 token vs 幕背景色的 WCAG 对比度 | 正文 < 4.5、大字（≥24px 或 ≥18.66px 且 weight ≥700）< 3 |
| `threeBudget` | 全 deck 可见 3D 块数量 | `> 2` warn；`> 4` error |
| `slideCount` | 幕数 | `< 3` 或 `> 24` info |
| `emptySlide` | 幕内可见块数为 0 | warn |
| `fontTooSmall` | `caption` 变体的实际字号（含 `typeScale`） | `< 13px` info |
| `outOfBounds` | 旋转后的外接框超出 1600×900 | 容忍 2px 出血；超出 `> 160px` 升 error |
| `missingAlt` | `image` 块 `alt` 为空 | info |
| `readingTime` | 单幕文本（含图注）阅读时长 | `> 90s` info；中文按 4.2 字/秒，英文按 2.6 词/秒 |
| `tooManyBlocks` | 单幕可见块数 | `> 18` info |
| `emptyBlock` | 文本/ SVG / HTML 内容为空白 | info |

### 5.3 params 形态

| code | params |
|---|---|
| `textOverflow` | `{ ratio, lines, height }`（height 是估算内容高度 px） |
| `contrast` | `{ ratio, threshold, size }` |
| `threeBudget` | `{ count, max }` |
| `slideCount` | `{ count, min, max }` |
| `fontTooSmall` | `{ size, min }` |
| `outOfBounds` | `{ over }` |
| `readingTime` | `{ seconds, max }` |
| `tooManyBlocks` | `{ count, max }` |
| `emptySlide` / `missingAlt` / `emptyBlock` | 无 |

### 5.4 严重度策略

- `error`：画面明确坏了（文本溢出 > 1.25×、越界 > 160px、3D 块 > 4）。
- `warn`：可能被裁切或看不清（溢出、对比度、空幕、3D 超预算、越界）。
- `info`：风格建议（幕数、块数、字号、阅读时长、缺 alt、空块）。

`severity` 由渲染层决定，panels 只负责按 code + severity 上色/排序。

### 5.5 文本溢出的估算方式（避免误报的关键）

- 折行按 CSS 行为近似：CJK 逐字断行、拉丁词整体断行、超长词才按字符硬拆；`white-space: pre-wrap` 的显式换行与段落间距（0.55em）都计入。
- 纵向用**可见字面高度**而非行盒高度：`size · (lines · lineHeight − (lineHeight − 1))`，即扣掉首尾行距的一半。这样「一行字刚好塞满一个行盒」的紧排块不会被误报，只有真正会被裁切的多行文本才报。

## 6. 性能预算与已知限制

**预算**

| 项 | 值 |
|---|---|
| 同时存活的 WebGL runtime | ≤ 4（超出按 LRU 挂起成静态海报） |
| 单帧后备缓冲像素 | ≤ 4.2M（超出自动降 pixelRatio，下限 0.5） |
| pixelRatio 上限 | `min(devicePixelRatio, 2)`（可传 `pixelRatioCap` 覆盖，硬上限 3） |
| 缩略图 WebGL | 0（`mode='thumb'` 永不创建） |
| 缩略图动效 | 0（`.lumen-slide[data-mode='thumb'] *` 关闭 animation/transition） |
| 缩略图外部请求 | 0（3D 用本地 dataURL 海报，HTML 不挂 iframe，图片走本地 blob） |
| 海报缓存 | 32 张 dataURL（LRU，约 2MB 量级） |
| 同时跑动画的幕 | 1（只有当前显示的那一幕） |

**已知限制**

- 幕栏里未访问过的 3D 幕只有「主题渐变 + preset 名」的占位，不会为了缩略图去建 WebGL；该幕在舞台渲染过一次之后才有真实海报。
- 被预算淘汰的块在当前这一幕不会自动重建 runtime（需要重新挂载，例如切幕再切回）；正常使用（一屏一幕）触发不到。
- `descriptor.orbitControls` 目前只写进 `data-interactive`，真正的轨道控制未实现（拖拽交互归 stage 层）。
- `mode='print' / 'export'` 的「只渲一帧」已实现，但还没有真实调用方（exporter 未接线）。
- WebGL 只在 Chrome + SwiftShader 环境验证过；真实 GPU、Safari 未见真机验证。
- `html` 的 `heightMode='content'` 会把 iframe 铺到内容高度并放开容器裁切，内容过高时会盖到相邻块（这是「随内容」语义的代价，已用 4× 块高封顶）。
- lint 的对比度与溢出都是**近似判断**：对比度按「文本色 token vs 幕背景色」算，不感知文本下方的形状块；溢出靠 `measureText` 折行估算，不做真实排版。两者都是「值得看一眼」的提示，不是像素级断言。
- 3D 只在 `play/stage/export/print` 创建；`thumb` 与 SSR 环境一律走降级视图。

## 附录 A：lint 文案键建议（panels 对照用）

> code 是稳定标识，文案由 panels 用 i18n 映射；下面的键名与文案是建议值，`{...}` 与 `issue.params` 的键一一对应。
> 建议命名空间：`editor.lint.*`。`ratio` / `seconds` / `size` 等数值已四舍五入，插值即可。

### A.1 按 code

| 建议键名 | zh | en | params |
|---|---|---|---|
| `editor.lint.code.slideCount` | 幕数 {count}，建议控制在 {min}–{max} 幕 | {count} slides — keep it between {min} and {max} | `count` `min` `max` |
| `editor.lint.code.emptySlide` | 这一幕没有可见内容 | This slide has no visible content | — |
| `editor.lint.code.tooManyBlocks` | 这一幕有 {count} 个块，建议不超过 {max} 个 | {count} blocks on one slide — {max} or fewer reads better | `count` `max` |
| `editor.lint.code.threeBudget` | 全篇有 {count} 个 3D 场景，建议不超过 {max} 个 | {count} 3D scenes in this deck — {max} or fewer keeps it fast | `count` `max` |
| `editor.lint.code.textOverflow` | 文本超出块范围（约 {ratio}×，{lines} 行） | Text overflows its block ({ratio}×, about {lines} lines) | `ratio` `lines` `height` |
| `editor.lint.code.contrast` | 对比度 {ratio}:1，低于 AA 要求的 {threshold}:1 | Contrast {ratio}:1 is below the AA threshold of {threshold}:1 | `ratio` `threshold` `size` |
| `editor.lint.code.fontTooSmall` | 字号 {size}px 小于下限 {min}px | Font size {size}px is below the {min}px minimum | `size` `min` |
| `editor.lint.code.outOfBounds` | 块超出画布 {over}px | Block extends {over}px past the canvas | `over` |
| `editor.lint.code.missingAlt` | 图片缺少替代文字 | Image has no alt text | — |
| `editor.lint.code.readingTime` | 这一幕约需 {seconds} 秒读完，建议控制在 {max} 秒内 | About {seconds}s of reading — keep a slide under {max}s | `seconds` `max` |
| `editor.lint.code.emptyBlock` | 块内容为空 | This block is empty | — |

### A.2 通用键

| 建议键名 | zh | en | 说明 |
|---|---|---|---|
| `editor.lint.severity.info` | 提示 | Info | 严重度标签 |
| `editor.lint.severity.warn` | 警告 | Warning | 严重度标签 |
| `editor.lint.severity.error` | 错误 | Error | 严重度标签 |
| `editor.lint.summary` | {error} 错误 · {warn} 警告 · {info} 提示 | {error} errors · {warn} warnings · {info} info | 取自 `summarizeLint()` |
| `editor.lint.clean` | 没有发现问题 | Nothing to fix | 空态（复用现有 `editor.inspector.lintClean` 亦可） |
| `editor.lint.rerun` | 重新检查 | Re-check | 手动触发按钮 |
| `editor.lint.jump` | 定位到该块 | Go to block | 点击条目跳转 |

### A.3 使用示例

```tsx
import { lintDeck, summarizeLint } from '@/lint'

const issues = useMemo(() => lintDeck(deck), [deck])   // deck 变化才重算
const counts = summarizeLint(issues)                    // { info, warn, error } 计数

// 键名是拼出来的：i18n 若是强类型键，这里显式断言一次即可
const keyOf = (code: string) => `editor.lint.code.${code}` as Parameters<typeof t>[0]

issues.map((issue) => ({
  key: `${issue.blockId ?? issue.slideId ?? 'deck'}:${issue.code}`,
  title: t(keyOf(issue.code), issue.params ?? {}),
  tone: issue.severity,                 // info | warn | error
  target: issue.blockId ?? issue.slideId, // 点击定位用
}))
```

> 排序建议：`error → warn → info`，同级别按幕序；`params` 里的值已经是四舍五入后的数字，不需要再格式化。

> 注意：`t()` 的第二个参数用完 `params` 后，`issue.params` 里的键名必须与文案占位符完全一致（本表已对齐）。
