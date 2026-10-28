import { expect, type Page } from '@playwright/test'

export interface ErrorCollector {
  errors: string[]
  assertClean: () => void
}

/** 收集 console error / pageerror，并在断言时给出可读列表。 */
export function collectErrors(page: Page): ErrorCollector {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  return {
    errors,
    assertClean: () => {
      expect(errors, errors.join('\n')).toHaveLength(0)
    },
  }
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(400)
}

/** 用真实鼠标坐标选中舞台上的第 n 个指定类型块（画布是几何命中层）。 */
export async function clickBlock(page: Page, type: string, index = 0) {
  const block = page.locator(`.stage-frame .lumen-slide [data-block-type="${type}"]`).nth(index)
  const box = await block.boundingBox()
  if (!box) throw new Error(`block ${type}[${index}] not found`)
  const x = box.x + Math.min(Math.max(box.width * 0.5, 8), box.width - 8)
  const y = box.y + Math.min(Math.max(box.height * 0.5, 8), box.height - 8)
  await page.mouse.click(x, y)
  await page.waitForTimeout(250)
  return box
}

export async function railCount(page: Page): Promise<number> {
  return page.locator('.rail__item').count()
}

export async function slideText(page: Page): Promise<string> {
  return page.locator('.stage-frame .lumen-slide').first().innerText()
}
