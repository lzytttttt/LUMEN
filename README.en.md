# LUMEN 幕光

[中文](README.md) · **English**

**An AI-native deck workbench in the browser.** Start at the Forge: prompt, outline, build, check, play — five stages on one stage. Keep editing on a real canvas, then ship a single self-contained HTML file that plays on double-click.

**Version: [v0.2.0](https://github.com/lzytttttt/LUMEN/releases/tag/v0.2.0)** — the Forge release.

Author: **无极Ayaya** · Project: [github.com/lzytttttt/LUMEN](https://github.com/lzytttttt/LUMEN) · Contact: [lzytttttt@gmail.com](mailto:lzytttttt@gmail.com) · License: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

> No backend, no telemetry, no remote fonts. Data lives in IndexedDB, the model endpoint is yours to fill in (local Ollama included), and the default is an offline Mock. `?channel=replay` can play a whole deck with no network at all.

## Portal

A standalone entry point, `portal.html` (the build artifact is likewise `dist/portal.html` and can be hosted on its own; dev URL `http://127.0.0.1:5273/portal.html`, or `?portal=1`). The `LUMEN` wordmark in the top-left of the workbench takes you back to the portal at any time.

The portal is a waterfall long page: the pitch → why (four real objections) → the five-stage Forge → five real interface windows → six capabilities → preferences and the closing call → author and license. It does not load the editor or the renderer; it only depends on settings and copy. The preferences drawer — generation channel / endpoint presets / fidelity tier / sound / reduced motion / UI language — writes straight to `lumen.prefs` and takes effect the moment you enter the workbench. `Enter` enters the workbench.

The author avatar is the GitHub one ([@lzytttttt](https://github.com/lzytttttt)). Author: **无极Ayaya** · Project: [github.com/lzytttttt/LUMEN](https://github.com/lzytttttt/LUMEN) · Contact: [lzytttttt@gmail.com](mailto:lzytttttt@gmail.com) · License: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

## First run

On the first open of the workbench (`settings.onboarded === false`) a three-step card appears in the bottom-right: **open the stage → generate a deck → play it**. Pressing "Start" opens the Forge with a sample prompt pre-filled; from then on each step lights up from a real action. No walls of onboarding text, no overlay, nothing blocking the canvas. "Skip" writes `onboarded`. `?onboard=1` forces it to replay, `?onboard=0` hides it.

## The Forge

All four entry points fire the same event: the top bar's "✦ Generate", the command palette (`⌘/Ctrl + K` → `forge.open`), the empty-canvas CTA, and **press-and-hold 400ms** on the left slide rail's "+" (a short press still creates a blank slide). `Esc` exits at any time; finished slides drop into the left rail immediately, and one undo takes you back to before the Forge.

| Stage | What you see | What you can do |
|---|---|---|
| Prompt | One sentence + three sample cards + slide-count / duration / visual toggles | The primary button stays disabled while empty; sample cards only fill in, never submit |
| Outline | 9 slide cards (3–20 slides) | Swap one, delete a slide, add a slide, drag to reorder; the first and last are locked |
| Build | Progress `3/9`, combo `×4` | Slide-by-slide drafting, cancel at any time; a cancel writes nothing |
| Check | Blockers (error) and flags (warn) | An error triggers one fallback reflow; if it still fails, "retry" that slide; no play entry appears while stalled |
| Play | `Play` / `Edit` | Full-screen playback, `Esc` back to the canvas; "another one" starts over |

**Pacing**: generation is not "the faster the better". The Forge queues pipeline events onto the timeline of the mock samples — the prompt holds for at least 640ms, adjacent slides 560ms, the last slide to the premiere seat 560ms, a recast 760ms (`src/forge/pacing.ts`). A fast model (the local Mock) and a real endpoint both get the same beat; `?still=1` and `?channel=replay&speed=0` (screenshots / e2e) mean zero wait.

- **Fidelity tiers L0–L3**: decided once, only ever downgrades, and can be pinned in settings (L0 static / L1 pipeline / L2 2.5D / L3 full motion). `?still=1` forces L0 — the visual baseline and low-end machines both run this tier.
- **Game layer**: combo (capped at ×6), mastery (Lv 1–12), achievements — all computed locally, zero blocking, zero network, and nothing is gated behind it.
- **Keyboard**: `Tab` cycles inside the stage, `Enter` submits/enters, `←/→` picks a card, `Alt+↑/↓` reorders, `Del` deletes a slide, `R` retries the stalled slide, `Esc` exits.

### Settings

The top bar's "Settings" gains a Forge section: tier (auto / L0–L3), game layer (simple / full), sound, autoplay, streaming toggle, reset progress, export diagnostics JSON.
The diagnostics JSON (`lumen-diagnostics.json`) is exported by you, manually, for bug reports; the app itself reports nothing.

### Offline replay

```text
http://127.0.0.1:5273/?channel=replay&speed=0      # replay fixtures, zero network requests
http://127.0.0.1:5273/?still=1&channel=replay&speed=0   # plus L0 on top (screenshots and e2e)
```

`?speed=0` feeds frames synchronously with no per-frame wait; replay data lives in `src/fixtures/ai/<setId>/*.json` (default `zh-normal`) and was recorded from a real model.
`?strict=0` disables strict `promptDigest` matching and falls back by task order (for demos).

## Screenshots

> Screenshots come from `node scripts/snapshot.mjs http://127.0.0.1:5273` (raw output in `harness/out/`, not committed),
> then get copied into `doc/screenshots/` and shipped with the repo. The five Forge states are shot with `?still=1` to avoid mid-animation frames.

| Editor | Play |
|---|---|
| ![editor](doc/screenshots/ui-editor.png) | ![play](doc/screenshots/ui-play.png) |

| Precision mode (Composer) | Studio |
|---|---|
| ![composer](doc/screenshots/ui-composer.png) | ![studio](doc/screenshots/studio-3d.png) |

The Forge (real v0.2.0 screenshots, shot with `?still=1`):

| Prompt | Outline |
|---|---|
| ![forge seed](doc/screenshots/forge-input.png) | ![forge deal](doc/screenshots/forge-deal.png) |

| Build (assemble + gate) | Play |
|---|---|
| ![forge cast](doc/screenshots/forge-cast.png) | ![forge premiere](doc/screenshots/forge-premiere.png) |

| Portal | First run |
|---|---|
| ![portal](doc/screenshots/portal.png) | ![onboarding](doc/screenshots/onboarding.png) |

Slides: [01](doc/screenshots/slides/slide-01.png) · [02](doc/screenshots/slides/slide-02.png) · [03](doc/screenshots/slides/slide-03.png) · [04](doc/screenshots/slides/slide-04.png) · [05](doc/screenshots/slides/slide-05.png) · [06](doc/screenshots/slides/slide-06.png) · [07](doc/screenshots/slides/slide-07.png) · [08](doc/screenshots/slides/slide-08.png) · [09](doc/screenshots/slides/slide-09.png) (9-slide sample)

## Capabilities

- **Forge**: a five-stage loop; 12 slide-card recipes, first/last locking, add/delete/reorder/retry; progress and cancel are real, and a cancel writes nothing.
- **Generation**: prompt → editable outline → slide-by-slide drafting; 12 layout recipes × 6 themes; per-slide rewrite, condense, timeline-ize, add SVG / add 3D.
- **Channels**: Mock (offline, deterministic) / OpenAI-compatible (streaming SSE, backoff retries, response cache) / Replay (offline playback); presets cover DeepSeek, OpenAI, Ollama, and self-hosted gateways.
- **Editing**: a 1600×900 canvas, multi-select / marquee, eight-way resize, rotate, smart guides + grid snapping, align and distribute, layers, lock and hide, inline text editing, 200-step undo.
- **Six block types**: `text` `shape` `image` `svg` `three` `html` (sandboxed iframe).
- **Playback**: full-screen, 5 transitions, presenter view (notes + timer + next slide), overview, autoplay, clicker support.
- **Export**: single-file HTML (plays from `file://`, `?print=1` to print a PDF), PDF, per-slide PNG, `.lumen.json` project files.
- **Lint**: overflow / contrast / font size / 3D budget / reading time under one ruler; AI output and hand-made output are held to the same standard, and errors become visible blockers on the Forge.
- **Bilingual**: instant ZH/EN UI switching (1,088 keys × 2 languages, and the keys must stay in parity).

## Quick start

```powershell
# 1) Dependencies (this machine uses a bundled pnpm outside the repo; a normal setup just uses pnpm install)
pnpm install

# 2) Develop (builds the player core first, then starts vite; the port is pinned to 5273)
pnpm dev            # → http://127.0.0.1:5273

# 3) Single actions (equivalent to calling the entries under node_modules directly, see doc/09)
pnpm test           # vitest (jsdom)
pnpm typecheck      # tsc --noEmit
pnpm lint:i18n      # zh/en key parity
pnpm snapshot       # screenshots into harness/out/
pnpm e2e            # Playwright (boots a dev server on 5274 automatically)

# 4) Production build (tsc + vite build; prebuild builds the player core first)
pnpm build
```

**Without pnpm** (this is how this repo's own acceptance runs are done):

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/@playwright/test/cli.js test
```

**Export**: the top bar's "Export" → standalone HTML (optionally inlining assets/notes, whole deck or current slide) / PDF (in-app print) / PNG (per slide, 2× by default) / project file.
The exported HTML shares its origin with the player core: `public/player/lumen-player.js` is a build artifact, so run `pnpm build:player` first on a new machine.

## Privacy

- No backend, no telemetry, no remote fonts; it works offline (the Mock / Replay channels both are offline).
- Data lives only in local IndexedDB (a single database `lumen-deck`, DB v3: `decks` / `assets` / `settings` / `forge` / `aiCache`). Clearing site data clears everything.
- Model endpoints and keys are filled in by you and stored only in local settings; exported `.lumen.json` files and standalone HTML contain neither endpoints nor keys.
- The diagnostics JSON must be exported manually from settings and sent by you — that is exactly the price of "no telemetry".
- Game progress is hard-capped at 6KB (single key `forge/progress`), writes are throttled to 500ms, and backgrounding forces a flush.

## Stack

| Layer | Choice |
|---|---|
| View | React 19.2 · TypeScript 5.9 (strict) · Vite 7.3 |
| State | zustand 5 + immer 11 (patch history, 200 steps) |
| Contract | zod 3.25 (`src/schema/deck.ts` is the single data contract) |
| 3D | three r186 (lazy-loaded on demand; thumbnails never create a WebGL context) |
| Other | DOMPurify 3 (SVG sanitizing) · CodeMirror 6 (SVG/HTML editing) · hand-rolled IndexedDB wrapper (`kv.ts`: single database `lumen-deck` v3 / five stores) |
| Tests | vitest 3 (jsdom, 19 files / 362 cases, sampled 2026-10-28) · Playwright 1.64 (8 e2e specs / 14 cases + screenshot harness) |

## Layout

```
src/
├─ schema/ state/ persistence/ themes/ styles/   # contracts, state, storage, themes, tokens
├─ render/                                       # the one renderer (stage/play/thumb/print/export)
├─ editor/                                       # canvas interactions, slide rail, inspector, toolbar, shortcuts
├─ ai/                                           # provider, channels (mock/openai/replay), prompts, recipes, outline/refine
├─ forge/                                        # the Forge: state machine, five stages, cards, HUD, tiers, game layer, pacing
├─ onboarding/ portal/                            # three-step first run / standalone portal (portal.html)
├─ fixtures/ai/                                  # replay offline fixtures (statically bundled via import.meta.glob)
├─ studio/                                       # SVG / 3D studio and curated library
├─ play/ player/                                 # player and player-core entry (IIFE build)
├─ export/                                       # standalone HTML, print/PDF, PNG, project file
├─ ui/ i18n/ sample/ version.ts                  # primitives, copy, 9-slide sample, single source of truth for the version
tests/unit/                                       # 19 files: pure logic, channel contracts, copy budgets
tests/e2e/                                        # Playwright: editor/play/i18n/export/print/Forge
scripts/                                          # dev server, player build, screenshot harness
doc/                                              # design and contract docs (00–09)
plan/v0.2.0/                                      # this release's evidence and constraints (00–09 + samples + traces)
```

## Docs

| Doc | Contents |
|---|---|
| [00 Engineering contract](doc/00-工程契约.md) | Technical facts, file ownership, commands, reporting format |
| [01 Product overview](doc/01-产品概述.md) | Positioning, seven AI-native principles, four main lines |
| [02 Architecture](doc/02-架构设计.md) | Module map, data flow, key decisions, startup sequence |
| [03 Data model and DSL](doc/03-数据模型与DSL.md) | Every Deck/Slide/Block/Theme field, grid, migration |
| [04 Editor](doc/04-编辑器.md) | Canvas, hit testing, drag/resize/rotate, snapping, shortcuts |
| [05 SVG and 3D rendering](doc/05-SVG与3D渲染.md) | Render contract, three runtime, SVG/HTML security boundary, lint |
| [06 AI orchestration](doc/06-AI编排.md) | Channels and error codes, 5 prompt sets, repair loop, 12 recipes, provenance |
| [07 Playback and export](doc/07-播放与导出.md) | Playback state machine and 5 transitions, presenter protocol, standalone HTML assembly, PDF/PNG/project files |
| [08 Design system](doc/08-设计系统.md) | Two token sets, 6 themes, type scale, primitives, accessibility |
| [09 Development and acceptance](doc/09-开发与验收.md) | Commands, test layers, DoD, FAQ |
| [plan/v0.2.0](plan/v0.2.0/README.md) | The Forge's scope, interface, game layer, motion, LLM spec, and acceptance matrix (this release's evidence) |

## License

This project is released under **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**.

- You may: copy, distribute, modify, and adapt it for non-commercial purposes.
- You must: credit **无极Ayaya**, link the license, and indicate whether changes were made.
- You may not: use this project or its derivatives for commercial purposes.
- Full legal text: [LICENSE-CC-BY-NC-4.0.txt](LICENSE-CC-BY-NC-4.0.txt); license home: <https://creativecommons.org/licenses/by-nc/4.0/>.
- For commercial licensing, contact: [lzytttttt@gmail.com](mailto:lzytttttt@gmail.com).

Unless a file says otherwise, this license applies to the whole repository (source code, docs, and design assets).
