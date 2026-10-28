import { mountPortal } from './mount'

const container = document.getElementById('portal-root')
if (container) {
  void mountPortal(container)
}
