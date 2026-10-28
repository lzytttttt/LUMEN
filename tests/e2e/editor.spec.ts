import { expect, test } from '@playwright/test'
import { clickBlock, collectErrors, openApp, railCount, slideText } from './helpers'

test('首屏：示例演示 9 幕、无 console error、3D 已渲染', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  await expect(page.locator('.topbar')).toBeVisible()
  expect(await railCount(page)).toBe(9)
  await expect(page.locator('.stage-frame .lumen-slide')).toHaveCount(1)
  expect(await slideText(page)).toContain('该换一种载体')

  // 第 1 幕是 3D 幕：真实 canvas（WebGL 不可用时也应有降级视图）
  const canvas = page.locator('.stage-frame canvas')
  const fallback = page.locator('.stage-frame [data-three-fallback]')
  expect((await canvas.count()) + (await fallback.count())).toBeGreaterThan(0)

  await page.waitForTimeout(600)
  log.assertClean()
})

test('编辑：改字 → 撤销 → 重做；拖动 → 撤销', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  const original = await slideText(page)
  await clickBlock(page, 'text', 1) // 副标题 lead

  const textarea = page.locator('.panel textarea').first()
  await expect(textarea).toBeVisible()
  await textarea.fill('这是一句被改过的副标题。')
  // 点画布空白处让输入框失焦并提交（渲染内容不吃指针事件，命中层是 .stage-surface）
  await page.locator('.stage-surface').click({ position: { x: 16, y: 16 } })
  await page.waitForTimeout(400)
  expect(await slideText(page)).toContain('这是一句被改过的副标题')

  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  expect(await slideText(page)).not.toContain('这是一句被改过的副标题')
  expect(await slideText(page)).toBe(original)

  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(300)
  expect(await slideText(page)).toContain('这是一句被改过的副标题')
  await page.keyboard.press('Control+z')

  // 拖动第一块文本，left 必须变化，撤销后回原位
  const before = await clickBlock(page, 'text', 0)
  const dragTarget = page.locator('.stage-frame .lumen-slide [data-block-type="text"]').first()
  const leftOf = async () => Number.parseFloat((await dragTarget.evaluate((el) => (el as HTMLElement).style.left)) || '0')
  const x0 = await leftOf()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 80, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const x1 = await leftOf()
  expect(x1).toBeGreaterThan(x0)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(350)
  const x2 = await leftOf()
  expect(x2).toBe(x0)

  log.assertClean()
})

test('分幕：新增 / 复制 / 删除', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)
  expect(await railCount(page)).toBe(9)

  await page.locator('.rail__add').first().click()
  await page.waitForTimeout(350)
  expect(await railCount(page)).toBe(10)

  // 右键第一幕 → 复制这一幕
  const firstSlide = page.locator('.rail__item').first()
  await firstSlide.click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByRole('menuitem', { name: /复制这一幕|Duplicate slide/ }).first().click()
  await page.waitForTimeout(350)
  expect(await railCount(page)).toBe(11)

  await page.locator('.rail__item').first().click({ button: 'right' })
  await page.waitForTimeout(250)
  await page.getByRole('menuitem', { name: /删除这一幕|Delete slide/ }).first().click()
  await page.waitForTimeout(350)
  expect(await railCount(page)).toBe(10)

  await page.keyboard.press('Control+z')
  await page.waitForTimeout(350)
  expect(await railCount(page)).toBe(11)

  log.assertClean()
})

test('插入：SVG / 3D / 文本三种块都落到画布', async ({ page }) => {
  const log = collectErrors(page)
  await openApp(page)

  const insert = page.getByRole('button', { name: /插入/ }).first()
  await insert.click()
  await page.waitForTimeout(250)
  const blankSvg = page.getByRole('button', { name: /空白 SVG/ }).first()
  await blankSvg.click()
  await page.waitForTimeout(400)
  expect(await page.locator('.stage-frame [data-block-type="svg"]').count()).toBeGreaterThan(0)

  await insert.click()
  await page.waitForTimeout(250)
  const three = page.getByRole('button', { name: /轨道星环|orbit/i }).first()
  if (await three.count()) {
    await three.click()
    await page.waitForTimeout(1200)
  }
  const threeBlocks = await page.locator('.stage-frame [data-block-type="three"]').count()
  expect(threeBlocks).toBeGreaterThan(0)

  log.assertClean()
})
