#!/usr/bin/env node
/**
 * 增量构建播放器内核到 public/player/。
 * 若源文件不比产物新则跳过（dev 每次启动不重复付 3s）。
 */
import { existsSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'src/player/entry.tsx')
const out = path.join(root, 'public/player/lumen-player.js')

if (!existsSync(entry)) {
  console.log('[player] src/player/entry.tsx 不存在，跳过')
  process.exit(0)
}

function newestMtime(dir) {
  let newest = 0
  if (!existsSync(dir)) return newest
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    if (name.isDirectory()) newest = Math.max(newest, newestMtime(p))
    else newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

const watched = ['src/player', 'src/render', 'src/styles', 'src/schema', 'src/themes', 'src/play', 'src/export']
let srcMtime = existsSync(path.join(root, 'vite.player.config.ts'))
  ? statSync(path.join(root, 'vite.player.config.ts')).mtimeMs
  : 0
for (const rel of watched) srcMtime = Math.max(srcMtime, newestMtime(path.join(root, rel)))

if (existsSync(out) && statSync(out).mtimeMs >= srcMtime) {
  console.log('[player] 产物已是最新，跳过')
  process.exit(0)
}

console.log('[player] 构建播放器内核…')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const r = spawnSync(process.execPath, [viteBin, 'build', '-c', 'vite.player.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '0' },
})
process.exit(r.status ?? 1)
