import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrap } from './bootstrap'
import './styles/tokens.css'
import './styles/base.css'
import './ui/primitives/primitives.css'
import './render/slide.css'
import './app.css'

async function main(): Promise<void> {
  await bootstrap()
  const container = document.getElementById('root')
  if (!container) throw new Error('#root not found')
  createRoot(container).render(<App />)
}

void main()
