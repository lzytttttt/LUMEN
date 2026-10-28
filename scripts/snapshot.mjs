/**
 * snapshot.mjs —— 视觉验收 harness。
 * 用法： node scripts/snapshot.mjs [baseURL] [--all-slides]
 * 产出： harness/out/ui-editor.png, ui-play.png, ui-composer.png, slides/*.png, contact-sheet.png
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'harness', 'out')
const slidesDir = path.join(outDir, 'slides')
mkdirSync(slidesDir, { recursive: true })

const base = process.argv[2] ?? 'http://127.0.0.1:5273'
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 })
const page = await context.newPage()

const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('.lumen-slide', { timeout: 20000 })
await page.waitForTimeout(900)
await page.screenshot({ path: path.join(outDir, 'ui-editor.png') })

// 逐幕导出舞台截图（直接截缩放后的舞台容器）
const slides = await page.locator('.stage-frame .lumen-slide').count()
if (slides > 0) {
  const railItems = page.locator('.rail__item')
  const total = await railItems.count()
  for (let i = 0; i < total; i += 1) {
    await railItems.nth(i).click()
    await page.waitForTimeout(260)
    const frame = page.locator('.stage-frame')
    await frame.screenshot({ path: path.join(slidesDir, `slide-${String(i + 1).padStart(2, '0')}.png`) })
  }
}

// 播放态
await page.locator('.rail__item').first().click()
await page.keyboard.press('Control+Enter')
await page.waitForTimeout(700)
await page.screenshot({ path: path.join(outDir, 'ui-play.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// Composer（右栏 AI 模式）
const composerBtn = page.getByRole('button', { name: /AI|编排/ }).first()
if (await composerBtn.count()) {
  await composerBtn.click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(outDir, 'ui-composer.png') })
}

writeFileSync(path.join(outDir, 'console-errors.json'), JSON.stringify(errors, null, 2))
console.log(`[snapshot] slides=${slides} errors=${errors.length}`)
if (errors.length) console.log(errors.slice(0, 10).join('\n'))

await browser.close()
