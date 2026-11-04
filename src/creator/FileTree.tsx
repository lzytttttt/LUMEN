/**
 * creator/FileTree.tsx —— 提案文件树（04 §5.2；虚拟根 `draft/<draftId>/`）。
 *
 * 只读展示 + 点击在代码视图打开；体积按 UTF-8 字节（与 24KB/16KB 校验同一把尺）。
 */
import type { CreatorProposal } from '@/plugins/types'
import { bytesOf } from '@/plugins/package'
import { sortCreatorFiles } from './proposal'
import { useCreatorT, CREATOR_KEYS } from './i18n'
import { useCreatorStore } from './store'

export function FileTree({ proposal }: { proposal: CreatorProposal }) {
  const t = useCreatorT()
  const codePath = useCreatorStore((state) => state.codePath)
  const setCodePath = useCreatorStore((state) => state.setCodePath)
  const setView = useCreatorStore((state) => state.setView)
  const files = sortCreatorFiles(proposal.files)

  return (
    <ul className="creator-tree" role="tree" aria-label={t(CREATOR_KEYS.files)}>
      {files.map((file) => {
        const active = file.path === codePath
        return (
          <li key={file.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-selected={active}
              className={active ? 'creator-tree__item creator-tree__item--active' : 'creator-tree__item'}
              onClick={() => {
                setCodePath(file.path)
                setView('code')
              }}
            >
              <span aria-hidden="true">{file.path.endsWith('.js') ? '{}' : file.path.endsWith('.json') ? '≣' : '◈'}</span>
              <span>{file.path}</span>
              {file.path === '.lumen-plugin.json' ? (
                <span className="creator-tree__badge">{t(CREATOR_KEYS.files)}</span>
              ) : null}
              <span className="creator-tree__size">{formatBytes(bytesOf(file.content))}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`
}
