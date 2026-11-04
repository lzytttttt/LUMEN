/**
 * creator.spec.ts —— E-40-04 创造模式离线全链路 / E-40-05 无模型模板起点（06 §4.2）。
 *
 * 契约：04 全篇（状态机 9 态 → 对外 7 值钩子）、06 §3.1 `data-creator-*`。
 * 通道固定 mock（`?channel=mock`，零网络），`?still=1` 关动画；`?creator=1` / `?creator=<template>` 直达。
 *
 * 钩子口径（creator 域 2026-11-04 修正后）：
 * - `[data-creator-panel]` 面板根（含 data-creator-state / data-creator-template-id / data-creator-source）；
 * - `[data-creator-proposal]` 只在提案卡；`[data-creator-diff]` 只在 diff 区；
 * - `[data-creator-template]` 只在模板按钮（首屏模板行始终可见，widget 排第一）；
 * - 试跑只读（D-40-09）：无 `deck:write` 授权时 trialing 期间不写 deck，`[data-creator-deck-writes]` 不出现；
 *   「保留后一键撤销」0.4.0 不存在（saved 为终态），撤销语义在试跑阶段（结果卡 revert）。
 */
import { expect, test, type Page } from '@playwright/test'
import { collectErrors } from './helpers'
import { pluginSkip } from './plugins-helpers'

pluginSkip()

const CREATOR_QUERY = '/?still=1&channel=mock&creator=1&onboard=0'

async function waitCreatorState(page: Page, state: string, timeout = 25_000): Promise<void> {
  await expect(page.locator('[data-creator-panel]')).toHaveAttribute('data-creator-state', state, { timeout })
}

/** Mock 在 dev 环境有 110ms 延迟，proposing 窗口很短：接受 proposing 或直接 proposal-ready。 */
async function waitProposalReady(page: Page): Promise<void> {
  await page.waitForFunction(
    (values) => {
      const panel = document.querySelector('[data-creator-panel]')
      const state = panel?.getAttribute('data-creator-state') ?? ''
      return values.includes(state)
    },
    ['proposing', 'proposal-ready'],
    { timeout: 25_000 },
  )
  await waitCreatorState(page, 'proposal-ready')
}

function creatorPanel(page: Page) {
  return page.locator('[data-creator-panel]')
}

async function submitPrompt(page: Page, text: string): Promise<void> {
  const composer = creatorPanel(page).locator('[data-creator-composer]')
  const textarea = composer.locator('textarea').first()
  await textarea.fill(text)
  await composer.locator('button').first().click()
}

test('E-40-04 创造模式离线全链路：一句话 → 提案 → 试跑（只读）→ 撤销恢复 → 保留启用', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto(CREATOR_QUERY, { waitUntil: 'networkidle' })
  await expect(creatorPanel(page)).toBeVisible({ timeout: 20_000 })
  await waitCreatorState(page, 'idle')

  // ① 输入一句话 → proposing|proposal-ready
  await submitPrompt(page, '给我一个暖色的主题皮肤')
  await waitProposalReady(page)

  // ② 提案卡：文件树/权限条/diff 区
  const proposal = creatorPanel(page).locator('[data-creator-proposal]')
  await expect(proposal).toHaveCount(1)
  await expect(proposal).toHaveAttribute('data-creator-proposal', /^draft\/[\w-]+@\d+$/)
  await expect(creatorPanel(page).locator('[data-creator-diff]')).toBeVisible()
  await expect(creatorPanel(page).locator('[data-permission]').first()).toBeVisible()
  const proposalId = await proposal.getAttribute('data-creator-proposal')
  expect(proposalId).toBeTruthy()

  // ③ 试跑：默认只读（D-40-09，无 deck:write 提案 → trialing 期间无 deck 写入钩子）
  await creatorPanel(page).getByRole('button', { name: /试跑|Trial/ }).first().click()
  await waitCreatorState(page, 'trialing')
  expect(await creatorPanel(page).locator('[data-creator-deck-writes]').count()).toBe(0)

  // ④ 撤销改造 → 工作台恢复（终态：applied + outcome=reverted）
  await creatorPanel(page).getByRole('button', { name: /撤销|Revert/ }).first().click()
  const revertConfirm = creatorPanel(page).locator('[data-creator-confirm="revert"]')
  await expect(revertConfirm).toBeVisible({ timeout: 10_000 })
  await revertConfirm.getByRole('button', { name: /撤销|Revert/ }).last().click()
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-state', 'applied', { timeout: 20_000 })
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-outcome', 'reverted')

  // ⑤ 再次试跑 → 保留 → 插件启用（applied + outcome=saved）
  await creatorPanel(page).getByRole('button', { name: /试跑|Trial/ }).first().click()
  await waitCreatorState(page, 'trialing')
  await creatorPanel(page).getByRole('button', { name: /保留|Keep/ }).first().click()
  const keepConfirm = creatorPanel(page).locator('[data-creator-confirm="keep"]')
  if (await keepConfirm.isVisible().catch(() => false)) {
    await keepConfirm.getByRole('button', { name: /保留|Keep/ }).last().click()
  }
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-state', 'applied', { timeout: 25_000 })
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-outcome', 'saved')
  await expect
    .poll(async () => Number((await page.locator('html').getAttribute('data-lumen-plugins')) ?? 0), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)

  // 结果卡：导出插件 / 新建 可继续（saved 是终态，无撤销入口）
  await expect(creatorPanel(page).getByRole('button', { name: /导出|Export/ }).first()).toBeVisible()
  log.assertClean()
})

test('E-40-05 无模型模板起点：?creator=widget → 模板行可见 + 直接 proposal-ready → 试跑保留', async ({ page }) => {
  const log = collectErrors(page)
  await page.goto('/?still=1&channel=mock&creator=widget', { waitUntil: 'networkidle' })
  await expect(creatorPanel(page)).toBeVisible({ timeout: 20_000 })

  // 根节点记下直达模板；模板行始终可见，widget 排第一（无模型模板，不起 AI）
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-template-id', 'widget')
  const templates = creatorPanel(page).locator('[data-creator-template]')
  await expect(templates.first()).toBeVisible()
  await expect(templates.first()).toHaveAttribute('data-creator-template', 'widget')

  await waitCreatorState(page, 'proposal-ready')
  await expect(creatorPanel(page).locator('[data-creator-proposal]')).toHaveCount(1)

  // 试跑 → 保留（widget 是代码式模板，能力 ui:slot/deck:read，无敏感项 → 一键保留）
  await creatorPanel(page).getByRole('button', { name: /试跑|Trial/ }).first().click()
  await waitCreatorState(page, 'trialing')
  await creatorPanel(page).getByRole('button', { name: /保留|Keep/ }).first().click()
  const keepConfirm = creatorPanel(page).locator('[data-creator-confirm="keep"]')
  if (await keepConfirm.isVisible().catch(() => false)) {
    await keepConfirm.getByRole('button', { name: /保留|Keep/ }).last().click()
  }
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-state', 'applied', { timeout: 25_000 })
  await expect(creatorPanel(page)).toHaveAttribute('data-creator-outcome', 'saved')
  await expect
    .poll(async () => Number((await page.locator('html').getAttribute('data-lumen-plugins')) ?? 0), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)
  log.assertClean()
})
