#!/usr/bin/env node
/** e2e 专用 dev server：先确保播放器内核已构建，再拉起 vite。 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const port = process.argv[2] ?? '5274'

spawnSync(process.execPath, [path.join(root, 'scripts/build-player.mjs')], { cwd: root, stdio: 'inherit' })

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const child = spawn(
  process.execPath,
  [viteBin, '--port', port, '--strictPort', '--host', '127.0.0.1'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '0' } },
)

const kill = (sig) => {
  child.kill(sig)
  process.exit(0)
}
process.on('SIGINT', () => kill('SIGINT'))
process.on('SIGTERM', () => kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
