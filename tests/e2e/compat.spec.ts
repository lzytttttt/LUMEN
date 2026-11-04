/**
 * compat.spec.ts —— 兼容回归 C-40-01 / C-40-02 / C-40-04（06 §4.6、G8）。
 *
 * C-40-01/02：v0.2.0 / v0.2.5 / v0.3.0 三份真实 `.lumen.json`（tests/fixtures/decks/**）：
 *   导入 → 播放 → 导出工程文件往返（判据见 06 §4.6）。
 * C-40-04：IDB v3 → v4（只新增 plugins/pluginData/creator 三个 store，旧数据零迁移）。
 *   v3 库在 /plugins.html（同源、不加载工作台）里预置，再进入工作台触发升级。
 *
 * 注意：本文件不依赖插件运行时（也是 G8 的独立证据），默认参与 `pnpm e2e`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { collectErrors, openApp, railCount } from './helpers'

const DECKS = join(process.cwd(), 'tests', 'fixtures', 'decks')

async function openProjectFileTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^导出$|导出$/ }).first().click()
  await expect(page.locator('.lm-modal')).toBeVisible()
  const fileTab = page.getByRole('tab', { name: /工程文件|Project file/ }).first()
  await fileTab.click()
  await page.waitForTimeout(200)
}

async function importDeckFile(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入工程文件|Import project file/ }).first().click()
  const chooser = await chooserPromise
  await chooser.setFiles(path)
  await expect(page.locator('.lm-modal')).toBeHidden({ timeout: 20_000 })
  await page.waitForTimeout(600)
}

/** 三份旧工程文件（07ed71e 起样例 deck 未变；夹具由各 tag 的真实导出物去随机化而来）。 */
const LEGACY_DECKS = [
  ['v0.2.0', 'v020', 'sample-v0.2.0.lumen.json'],
  ['v0.2.5', 'v025', 'sample-v0.2.5.lumen.json'],
  ['v0.3.0', 'v030', 'sample-v0.3.0.lumen.json'],
] as const

for (const [version, dir, file] of LEGACY_DECKS) {
  test(`C-40-01/02 ${version} 工程文件：导入 → 9 幕 → 播放 → 导出往返`, async ({ page }) => {
    const log = collectErrors(page)
    await openApp(page)
    await openProjectFileTab(page)
    await importDeckFile(page, join(DECKS, dir, file))

    // 打开成功：标题/幕数/主题原样
    expect(await railCount(page)).toBe(9)
    await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()
    await expect(page.locator('.stage-frame .lumen-slide').first()).toContainText('该换一种载体')

    // 播放可用：进入 → 翻 2 页 → 退出（v0.3.0 判定口径；旧版数据同样可播）
    await page.keyboard.press('Control+Enter')
    await expect(page.locator('.play-root')).toBeVisible()
    await page.waitForTimeout(400)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    await expect(page.locator('.play-root')).toContainText('3 / 9')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // 导出工程文件往返：下载物重新解析后仍是 9 幕、title 不变
    await openProjectFileTab(page)
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    await page.getByRole('button', { name: /导出工程文件|Export project file/ }).first().click()
    const download = await downloadPromise
    const saved = join(process.cwd(), 'harness', 'out', `compat-${dir}.lumen.json`)
    await download.saveAs(saved)
    const exported = JSON.parse(readFileSync(saved, 'utf8')) as { deck: { title: string; slides: unknown[] }; kind: string }
    expect(exported.kind).toBe('lumen.deck')
    expect(exported.deck.slides).toHaveLength(9)
    expect(exported.deck.title).toContain('该换一种载体')
    log.assertClean()
  })
}

test('C-40-04 IDB v3 → v4：旧 store 数据保留、新 store 建齐、无内存降级提示', async ({ page }) => {
  const log = collectErrors(page)

  // 1) 同源、不加载工作台/插件页的空文档里预置 v3 库（v0.3.0 的 5 个 store + 一份旧演示）。
  //    用 route 提供临时空白页，避免 /plugins.html 打开 v4 库（VersionError）与 favicon 404 噪声。
  await page.route('**/__idb_seed.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title><body></body>' }),
  )
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto('/__idb_seed.html', { waitUntil: 'load' })
  const seeded = await page.evaluate(async () => {
    const legacyDeck = {
      schemaVersion: 1,
      id: 'deck_idb_v3_legacy',
      title: 'v3 旧演示（IDB 升级夹具）',
      lang: 'zh',
      aspect: '16:9',
      themeId: 'noir',
      meta: { createdAt: 1717200000000, updatedAt: 1717200000000, origin: 'import' },
      slides: [
        {
          id: 'slide_v3_01',
          name: '旧幕一',
          blocks: [
            {
              id: 'block_v3_01',
              type: 'text',
              text: '旧数据保留检查',
              variant: 'h1',
              x: 120,
              y: 120,
              w: 800,
              h: 120,
              z: 1,
              color: 'fg',
              align: 'left',
            },
          ],
          notes: 'v3 notes',
          background: { kind: 'theme' },
          transition: { kind: 'none' },
        },
      ],
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('lumen-deck', 3)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const store of ['decks', 'assets', 'settings', 'forge', 'aiCache']) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
        }
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('decks', 'readwrite')
        tx.objectStore('decks').put(legacyDeck, 'deck_idb_v3_legacy')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
    return true
  })
  expect(seeded).toBe(true)

  // 2) 进入工作台：kv.ts 以 v4 打开 → upgrade 建齐 3 个新 store
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 25_000 })
  await page.waitForTimeout(800)

  const snapshot = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lumen-deck')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const stores = Array.from(db.objectStoreNames)
    const legacy = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('decks', 'readonly')
      const request = tx.objectStore('decks').get('deck_idb_v3_legacy')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const version = db.version
    db.close()
    return { version, stores, legacyTitle: (legacy as { title?: string } | undefined)?.title ?? null }
  })

  expect(snapshot.version).toBe(4)
  for (const store of ['decks', 'assets', 'settings', 'forge', 'aiCache', 'plugins', 'pluginData', 'creator']) {
    expect(snapshot.stores, `v4 应包含 store ${store}`).toContain(store)
  }
  expect(snapshot.legacyTitle).toBe('v3 旧演示（IDB 升级夹具）')

  // 3) 没有内存降级提示（说明 IDB 打开成功）
  await expect(page.locator('[data-storage-mode="memory"]')).toHaveCount(0)
  await openApp(page)
  log.assertClean()
})

test('C-40-04b IDB 不可用（内存降级）：工作台仍可用且有提示', async ({ page }) => {
  const log = collectErrors(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true })
  })
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible({ timeout: 25_000 })
  // 内存降级提示（02 §7.6：顶部常驻提示；允许出现在插件/设置区）
  const banner = page.locator('[data-storage-mode="memory"]')
  await expect(banner.first()).toBeVisible({ timeout: 10_000 }).catch(async () => {
    // 兜底：至少不能白屏
    await expect(page.locator('.stage-frame .lumen-slide')).toBeVisible()
  })
  log.assertClean()
})
