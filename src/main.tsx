import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrap } from './bootstrap'
import { registerServiceWorker } from './pwa/register'
import './styles/tokens.css'
import './styles/base.css'
import './ui/primitives/primitives.css'
import './render/slide.css'
import './app.css'

async function main(): Promise<void> {
  const container = document.getElementById('root')
  if (!container) throw new Error('#root not found')

  // 生产构建注册离线壳；dev / ?portal=1 / ?print 内部会自行跳过。
  registerServiceWorker()

  // `?portal=1` 在同一个入口里渲染门户页（独立页面仍是 `portal.html`）；不初始化编辑器数据。
  if (new URLSearchParams(window.location.search).get('portal') === '1') {
    const { mountPortal } = await import('./portal/mount')
    await mountPortal(container)
    return
  }

  await bootstrap()
  createRoot(container).render(<App />)
}

void main()
