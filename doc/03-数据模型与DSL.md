# 03 数据模型与 DSL —— schema/deck.ts 字段全表

> `src/schema/deck.ts` 是演示数据的**唯一契约**：AI 产物、导入文件、持久化数据、导出物都必须先过它。
> 本文按字段列全，凡写"默认"的值都是 zod `.default()` 在 parse 时补的；`schema/factory.ts` 与这些默认值保持同一套数值。

## 1. 契约总览

| 类型 | 用途 | 校验位置 |
|---|---|---|
| `Deck` | 一份演示：主题、语言、幕列表、元信息 | `deckSchema` |
| `Slide` | 一幕：块列表、备注、背景、转场、时长 | `slideSchema` |
| `Block` | 6 种块的判别联合（`discriminatedUnion('type')`） | `blockSchema` |
| `Theme` | 6 套令牌的数据形态 | `themeSchema` |
| `ThreeDescriptor` | 3D 场景的受限描述符 | `threeDescriptorSchema` |
| `Outline` | AI 大纲（比 deck 粗一档，不含几何） | `outlineSchema` |
| `DeckFile` | 工程文件 `.lumen.json`（deck + 内联素材） | `deckFileSchema` |

zod 版本 3.25.76。所有 schema 由同一个 `deck.ts` 导出，**不允许在别处重新声明等价结构**。

### 1.1 常量

| 常量 | 值 | 含义 |
|---|---|---|
| `STAGE_W` | 1600 | 舞台宽（设计像素） |
| `STAGE_H` | 900 | 舞台高 |
| `SAFE_X` | 120 | 左右安全边距 |
| `SAFE_Y` | 96 | 上下安全边距 |
| `SCHEMA_VERSION` | 1 | 当前 schema 版本 |

## 2. Deck

| 字段 | 类型 | 默认 | 约束 | 说明 |
|---|---|---|---|---|
| `schemaVersion` | literal | `1` | 必须等于 `SCHEMA_VERSION` | 迁移入口（见 §11） |
| `id` | string | — | `min(1)` | `newId('deck')` 生成 |
| `title` | string | — | 1–160 | 顶栏可改，`deckOps.setTitle` 截断 160 |
| `lang` | `'zh' \| 'en'` | `'zh'` | 枚举 | 演示内容语言，独立于 UI 语言 |
| `aspect` | literal | `'16:9'` | 只能是 `'16:9'` | 目前不参与计算 |
| `themeId` | string | `'noir'` | 任意 string（`getTheme` 兜底） | 不在 `THEMES` 里时退回 noir |
| `themeOverrides` | object | `undefined` | 7 个颜色键可选 | 只需给要覆盖的键 |
| `slides` | `Slide[]` | — | `min(1)` | 空 deck 不合法 |
| `meta` | object | 见下 | — | `createdAt` `updatedAt` `origin` `prompt?` |

> `meta` 的默认值是一个**在模块加载时求值一次**的对象字面量（`default({ createdAt: Date.now(), ... })`），所以缺 `meta` 的输入会共用同一组时间戳；内层的函数默认值实际不会被执行。

`meta.origin` 取 `'sample' \| 'ai' \| 'manual' \| 'import'`（默认 `'manual'`）；`meta.prompt` ≤2000 字符，存最近一次生成用的提示。

`themeOverrides` 的键：`bg` `fg` `muted` `surface` `line` `accent` `accent2`，值都是 CSS 颜色字符串（`rgb()/hsl()` 也接受，lint 会自己解析）。

## 3. Slide

| 字段 | 类型 | 默认 | 约束 | 说明 |
|---|---|---|---|---|
| `id` | string | — | `min(1)` | |
| `name` | string | `undefined` | ≤120 | 幕栏显示名 |
| `blocks` | `Block[]` | `[]` | ≤120 | 顺序不作为层级，层级看 `z` |
| `notes` | string | `undefined` | ≤8000 | 讲者视图的备注 |
| `recipe` | `RecipeId` | `undefined` | 12 选 1 | 记录"这一幕是怎么排的"，供微调/重排参考 |
| `background` | object | `{kind:'theme'}` | `kind: 'theme' \| 'solid'`，`color?: ColorToken` | solid 时取 `--d-<color>` |
| `transition` | object | `{kind:'fade', ms:420}` | `ms` 0–2000 | 5 种转场 |
| `durationMs` | number | `undefined` | 0–600000 | 自动播放停留；缺省取全局设置 |
| `provenance` | `Provenance` | `undefined` | — | AI 生成的幕 |

枚举全集：

- `RecipeId`：`cover` `statement` `split` `grid3` `grid4` `timeline` `compare` `quote` `data` `process` `gallery` `closing`。
- `TransitionKind`：`none` `fade` `push` `wipe` `flip3d`。

## 4. Block

### 4.1 公共字段（`blockBaseFields`）

| 字段 | 类型 | 默认 | 约束 | 说明 |
|---|---|---|---|---|
| `id` | string | — | `min(1)` | `newId(type)` |
| `name` | string | `undefined` | ≤120 | 图层名 |
| `x` `y` | number | — | 无（可负） | 允许出血，clamp 由编辑层负责 |
| `w` `h` | number | — | ≥1 | 最小尺寸实际由 `MIN_SIZE = 8` 兜底 |
| `z` | int | `0` | — | **创建时**由 `nextZ()` 保证递增；schema 默认 0 |
| `rotation` | number | `0` | -360–360 | 顺时针角度 |
| `opacity` | number | `1` | 0–1 | |
| `locked` | boolean | `false` | — | 锁定后不参与拖动/删除 |
| `hidden` | boolean | `false` | — | 渲染前被过滤 |
| `enter` | enum | `'none'` | `none/fade/rise/scale` | 入场动效，仅 `play` |
| `enterDelayMs` | number | `0` | 0–3000 | 转成 `animation-delay` |
| `provenance` | `Provenance` | `undefined` | — | 溯源徽标 |
| `aiSnapshot` | string | `undefined` | ≤400000 | 生成时快照 JSON，用于"还原 AI 版本" |

### 4.2 六种块

| 类型 | 独有字段（类型 / 默认 / 约束） |
|---|---|
| `text` | `text: string` ≤6000；`variant` 默认 `body`；`align` 默认 `left`（`left/center/right`）；`color` 默认 `fg`；`inline` 默认 `true`；`tracking?` -0.12–0.4；`lineHeight?` 0.8–2.4；`weight?` 100–900；`maxWidth?` |
| `shape` | `kind` 默认 `rect`（`rect/ellipse/line/triangle/rule`）；`fill` 默认 `surface`；`stroke?`；`strokeWidth` 默认 0（0–40）；`radius?` 0–200；`dash` 默认 `false` |
| `image` | `assetId` `min(1)`；`fit` 默认 `cover`（`cover/contain`）；`radius` 默认 0（0–200）；`dim` 默认 0（0–0.9）；`caption?` ≤160；`alt?` ≤200 |
| `svg` | `source` ≤`512*1024` 字符；`viewBox` 默认 `[0,0,1600,900]`；`animate` 默认 `none`（`none/float/pulse/spinSlow/draw`）；`presetId?` ≤60；`opacity` 默认 1 |
| `three` | `descriptor`（§6）；`interactive` 默认 `false`；`bg` 默认 `transparent`；`posterAssetId?` |
| `html` | `html` ≤`200*1024` 字符；`css?` ≤`100*1024`；`heightMode` 默认 `block`（`block/content`）；`sandboxVersion` literal `1` |

`svg.opacity` 与公共 `opacity` 同名字段各自独立（schema 里 svg 块重新声明了一次，默认值相同）；改透明度时**两个都要写**才不会有一边被覆盖。

## 5. Theme

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `id` | string | — | 与 `THEMES` 的键一致 |
| `name` | `{ zh, en }` | — | 两语齐全 |
| `vibe` | `{ zh, en }` | `undefined` | 主题气质描述，只在 UI 里用 |
| `colors` | 7 键对象 | — | `bg fg muted surface line accent accent2` |
| `font` | `{ body, display, mono }` | — | 只能是系统字体栈 |
| `typeScale` | number | `1` | 0.8–1.25 |
| `typeOverrides` | `Record<TextVariant, Partial<TypeStyle>>` | `undefined` | 按变体覆盖 weight/tracking 等 |
| `radius` | number | `8` | 0–64（px） |
| `motion` | `{ ease, ms }` | `{ ease: 'cubic-bezier(.32,.72,0,1)', ms: 420 }` | `ms` 80–1600 |

`TypeStyle` = `{ size 8–240, weight 100–900, lineHeight 0.8–2.4, tracking -0.12–0.4 }`。实际字号由 `typeScaleOf(theme)` 或 `typeStyleOf(theme, variant)` 算出：`round(base.size × typeScale × 10) / 10`。

## 6. ThreeDescriptor

`threeDescriptorSchema` 全部字段有默认值，因此 `{ preset: 'orbit' }` 也能通过。

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `preset` | `orbit/showcase/wave-field/particle-cloud/torus/stack/globe` | `orbit` | `objects` 为空时的构图 |
| `palette` | `accent/mono/duotone` | `accent` | 主题色 → 四色语义 |
| `light` | `studio/sunset/neon/soft` | `studio` | 灯光组 |
| `bg` | `transparent/theme/void` | `transparent` | renderer 清除色 |
| `camera` | `distance` 1.6–24 / `elevation` -0.9–1.1 / `fov` 18–80 | `7 / 0.28 / 42` | 弧度制仰角 |
| `motion` | `kind` 默认 `rotate`；`speed` 0–2 | `rotate / 0.42` | 只作用于构图根节点 |
| `objects` | `ThreeObject[]`，≤24 | `[]` | 非空时忽略 preset 构图 |
| `grain` | 0–1 | `0` | CSS 噪点透明度 |
| `orbitControls` | boolean | `false` | 目前只写进 `data-interactive` |

`ThreeObject`：`shape`（`box/sphere/torus/torusKnot/cone/cylinder/octa/plane/icosa`，默认 `box`）、`material`（`standard/physical/toon/wireframe`，默认 `standard`）、`tint`（`accent/accent2/fg/muted/surface`，默认 `accent`）、`scale` 0.05–6（默认 1）、`pos` / `rot`（三元组，默认 `[0,0,0]`）、`metalness?` / `roughness?`（0–1）。

映射到画面的规则见 `doc/05-SVG与3D渲染.md` §2（预设、材质、灯光、构图自适应）。

## 7. Outline（AI 大纲）

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `title` | string | — | 1–120 |
| `subtitle` | string | `undefined` | ≤200 |
| `lang` | `'zh' \| 'en'` | `'zh'` | |
| `slides` | `OutlineSlide[]` | — | **2–24** |

`OutlineSlide`：`recipe` 默认 `statement`；`headline` 1–120；`lead?` ≤220；`points` ≤6 条、每条 ≤120；`visual` 判别联合默认 `{kind:'none'}`（`{kind:'svg', brief ≤240}` / `{kind:'three', preset?}`）；`notes?` ≤600。

大纲**不含几何**：块坐标全部由 `ai/recipes.ts` 的 12 个配方按栅格算出来。

## 8. DeckFile 与 Provenance

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `kind` | literal | `'lumen.deck'` | 文件类型标记 |
| `schemaVersion` | literal | `1` | |
| `exportedAt` | number | `Date.now()` | 导出时刻 |
| `deck` | `Deck` | — | |
| `assets` | `Record<string, string>` | `{}` | `assetId → dataURL` |

`Provenance`：`provider`（必有）、`model?`、`recipeId?`、`promptDigest?`（`shortHash(prompt)` 前 10 位）、`at`（时间戳）、`note?`。

## 9. 坐标系与栅格

- 舞台固定 **1600 × 900** 设计像素（16:9）；`x/y/w/h/rotation/fontSize/strokeWidth` 全是设计像素，缩放只在最外层 `transform: scale()` 做一次。
- 安全边距：左右 **120**、上下 **96** → 内容区 1360 × 708。
- 12 列栅格（实际实现只在 `ai/recipes.ts`）：`CONTENT_W = 1360`、`GAP = 24`、`COL_W = (1360 − 24×11) / 12 ≈ 91.33`；`col(start, span)` 的第 `start` 列（0 起）x 坐标 = `120 + start × (COL_W + 24)`，宽 = `span × COL_W + (span−1) × 24`。
- 出血规则：`clampToStage()` 允许块最多留在舞台外"只露 24px"（`BLEED = 24`），`MIN_SIZE = 8`，网格步进 `GRID = 8`；lint 的越界容忍是 2px（`LINT_LIMITS.bleed`）。

## 10. 颜色令牌与字号阶

### 10.1 颜色令牌（`ColorToken`，7 个）

`bg` `fg` `muted` `surface` `line` `accent` `accent2` → 渲染时映射为 `var(--d-bg)` … `var(--d-accent2)`。块的 `color/fill/stroke/background.color` 都只接受令牌名，**不接受裸色值**；唯一例外是 `deck.themeOverrides`（覆盖令牌本身）。

### 10.2 字号阶（`BASE_TYPE`，未乘 `typeScale`）

| 变体 | size | weight | lineHeight | tracking | 字体族 |
|---|---|---|---|---|---|
| `display` | 104 | 600 | 1.02 | -0.03em | display（衬线/主题指定） |
| `h1` | 64 | 600 | 1.08 | -0.02em | display |
| `h2` | 40 | 600 | 1.16 | -0.01em | display |
| `lead` | 28 | 400 | 1.50 | 0 | body |
| `body` | 22 | 400 | 1.62 | 0 | body |
| `caption` | 15 | 500 | 1.40 | +0.08em | body |
| `mono` | 18 | 500 | 1.50 | 0 | mono |

各主题的实际字号（`typeScaleOf`）：见 `doc/08-设计系统.md` §3 的对照表。

## 11. 校验与迁移

`src/schema/migrate.ts` 只做两件事：**先宽松升级，再严格校验**。

```ts
parseDeck(input)      // → { ok, value?, issues: string[] }
parseDeckFile(input)  // 允许裸 deck（无 kind 包装）直接导入
```

- `upgrade()` 是就地补字段的宽松步骤：缺 `schemaVersion` 补当前版本，缺 `meta` 补 `{createdAt, updatedAt, origin:'import'}`，`themeId` 非字符串补 `'noir'`，`lang` 非字符串补 `'zh'`，`schemaVersion === 0` 升到 1。
- 升级后仍走 `deckSchema.safeParse`：**未知字段被丢弃、非法值直接失败**，失败信息经 `formatIssues(error, 8)` 变成 `path: message` 最多 8 条。
- `loadDeck()`（持久化侧）不做升级，只 `safeParse`；本地数据不符合当前 schema 时打 `console.warn` 并当作没有 deck。
- `titleFromFileName()` 从文件名猜标题（去 `.lumen.json`/`.html` 后缀、`_`/`-` 转换、截断 120，兜底"未命名演示"）。

## 12. 最小 deck JSON（可直接粘贴验证）

下面这份三幕 deck 已用 `deckSchema.safeParse` 实跑通过（zod 3.25.76），没有写的字段全部由默认值补齐：

```json
{
  "schemaVersion": 1,
  "id": "deck_demo0001",
  "title": "三幕示例",
  "lang": "zh",
  "themeId": "noir",
  "slides": [
    {
      "id": "slide_cover",
      "blocks": [
        { "id": "text_title", "type": "text", "x": 120, "y": 300, "w": 900, "h": 220,
          "text": "演示，\n该换一种载体了", "variant": "display", "color": "fg" }
      ]
    },
    {
      "id": "slide_svg",
      "blocks": [
        { "id": "svg_art", "type": "svg", "x": 880, "y": 120, "w": 600, "h": 400,
          "source": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 400\"><circle cx=\"300\" cy=\"200\" r=\"120\" fill=\"none\" stroke=\"var(--d-accent)\" stroke-width=\"3\"/></svg>",
          "viewBox": [0, 0, 600, 400] }
      ],
      "transition": { "kind": "push", "ms": 520 },
      "notes": "讲者备注：先讲载体，再讲体验。"
    },
    {
      "id": "slide_close",
      "blocks": [
        { "id": "three_scene", "type": "three", "x": 200, "y": 180, "w": 700, "h": 540,
          "descriptor": { "preset": "orbit", "motion": { "kind": "rotate", "speed": 0.3 } } },
        { "id": "text_close", "type": "text", "x": 980, "y": 380, "w": 480, "h": 160,
          "text": "开始第一幕", "variant": "h1" }
      ]
    }
  ],
  "meta": { "createdAt": 1, "updatedAt": 2, "origin": "manual" }
}
```

校验通过后，`three_scene` 会被补全成：`preset 'orbit'`、`palette 'accent'`、`light 'studio'`、`bg 'transparent'`、`camera {7, 0.28, 42}`、`motion {rotate, 0.3}`、`objects []`、`grain 0`、`orbitControls false`、`interactive false`。

## 13. 已知限制

- 单幕 120 块、单文件 24 幕是 schema 硬上限，超了直接 parse 失败而不是截断；批量导入需要调用方先拆。
- `z` 的 schema 默认值是 0，只有 `ops.add/addMany` 会算 `nextZ()`；手写 JSON 里不写 `z` 时多块同层，靠数组顺序兜底。
- `svg.opacity` 与公共 `opacity` 是两个字段（历史遗留），只改一个会出现"属性面板改了没反应"。
- `aspect` 被限制成字面量 `'16:9'`，没有 4:3/竖版分支；渲染层尺寸也是硬编码 1600×900。
- `parseDeck` 会**丢弃未知字段**，所以"迁移"只能补已知字段，无法保留未来版本的新增字段。
- `slide.durationMs` 与全局自动播放时长是两套来源，缺省回落到设置值，界面上不做合并展示。
- `provenance.promptDigest` 只是提示词短哈希，不可反查原文；原文若没留在 `meta.prompt` 就找不回来了。
- `meta` 的默认时间戳在模块加载时算一次，批量导入多份缺 `meta` 的文件时它们会显示同一时刻（见 §2 注）。
