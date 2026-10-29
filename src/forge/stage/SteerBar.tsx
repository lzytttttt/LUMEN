/**
 * forge/stage/SteerBar.tsx —— 纠偏条（v0.2.5 §1 动作 4、§3.2、§3.6、§4）。
 *
 * 一句话追加到**下一幕边界**：`fromIndex` 由 ForgeApp 按「已落位数」给出，
 * reducer 把它以 `；` 追加进所有 `i >= fromIndex` 且尚未落位的幕 `brief`（§2 硬约束 4）。
 * 已生效的条目不再可撤销（`pendingSteer` 只留 `fromIndex > done` 的），因为改已经生成的幕
 * 只有「重试这一幕」一条路，撤销队列改不了成品。
 *
 * 硬约束：本文件的文字预算区块计数必须为 0（标签一律 ghost 级小字）；
 * 钩子：`data-forge-steer`（根）/ `data-steer-count`（队列条数）。
 */
import { useCallback, useState } from 'react'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { STEER_TEXT_MAX, pendingSteer, steerLabel } from '../steer'
import type { SteerBarProps } from '../ui'

export function SteerBar(props: SteerBarProps) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const [draft, setDraft] = useState('')

  /**
   * 「已排队」= 还没被管线吃掉的那几条。判定用 `done - 1`：
   * 一条 `fromIndex = done` 的纠偏，在 done 这一幕**落位之前**仍然排在队里
   * （`fromIndex > done - 1`），落位之后才算生效 —— 这比 `fromIndex > done` 更贴近「第 n 幕起生效」。
   */
  const pending = pendingSteer(props.notes, props.done - 1)
  /** 右下角那句「第 n 幕起生效」由 steer.ts 给（它持有 lang 与序号换算，UI 不自造句子）。 */
  const from = props.notes.length > 0 ? steerLabel(props.notes, props.total, lang) : ''

  const submit = useCallback(() => {
    const text = draft.trim()
    if (text === '' || !props.busy) return
    props.onSteer(text)
    setDraft('')
  }, [draft, props])

  return (
    <div
      className="forge-steer"
      data-forge-steer
      data-steer-count={pending.length}
      data-steer-total={props.notes.length}
      data-steer-live={props.busy ? '1' : '0'}
    >
      <div className="forge-steer__row">
        <input
          className="forge-steer__input"
          data-forge-steer-input
          type="text"
          value={draft}
          maxLength={STEER_TEXT_MAX}
          spellCheck={false}
          autoComplete="off"
          /* 生成中正是要打字的时候：这里绝不能 readOnly（那是把纠偏关在门外）。 */
          placeholder={t('forge.cast.steerHint')}
          aria-label={t('forge.cast.steerHint')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // 纠偏输入框吃掉 Esc：这里退的是这一句，不是整个造幕台（ForgeApp 的 Esc 仍是关闭）。
              event.stopPropagation()
              event.preventDefault()
              setDraft('')
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="forge-steer__send"
          data-forge-steer-send
          disabled={draft.trim() === ''}
          onClick={submit}
        >
          {t('forge.cast.steer')}
        </button>
      </div>

      {pending.length > 0 ? (
        <div className="forge-steer__queue">
          <span className="forge-steer__queued">{t('forge.cast.steerQueued', { n: pending.length })}</span>
          {from !== '' ? <span className="forge-steer__from">{from}</span> : null}
          <ul className="forge-steer__notes">
            {pending.map((note) => (
              <li key={note.id} className="forge-steer__note" data-steer-id={note.id}>
                <span className="forge-steer__text">{note.text}</span>
                <button
                  type="button"
                  className="forge-steer__undo"
                  data-steer-undo={note.id}
                  onClick={() => props.onUndo(note.id)}
                >
                  {t('forge.cast.steerUndo')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
