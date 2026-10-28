/**
 * PresenterWindow.tsx —— 讲者视图的第二个窗口。
 *
 * 这个窗口**不加载 React 应用**：`window.open` 之后用 `document.write` 注入一份
 * 自绘 HTML + 内联 CSS + 一段连接 BroadcastChannel 的脚本，主窗只负责广播状态。
 *
 * 安全约定（重要）：
 * - 注入的 HTML 里没有任何 deck 内容，deck 的标题/备注一律走 `textContent` 写入；
 * - 只有 i18n 文案会拼进脚本，且经过 `JSON.stringify` + `<` 转义，杜绝 `</script>` 注入。
 */
import type { Lang } from '@/i18n'
import { translate } from '@/i18n'
import { SYNC_CHANNEL } from './presenter'

const WINDOW_FEATURES = 'width=1120,height=760,menubar=no,toolbar=no,location=no,status=no,scrollbars=yes'

export interface PresenterLabels {
  title: string
  notes: string
  timer: string
  current: string
  upNext: string
  next: string
  prev: string
  blackout: string
  resume: string
  timerReset: string
  noNotes: string
  slideOf: string
  endOfDeck: string
  syncHint: string
  noChannel: string
}

function labelsFor(lang: Lang): PresenterLabels {
  return {
    title: translate(lang, 'play.presenter'),
    notes: translate(lang, 'play.notes'),
    timer: translate(lang, 'play.timer'),
    current: translate(lang, 'play.current'),
    upNext: translate(lang, 'play.upNext'),
    next: translate(lang, 'play.next'),
    prev: translate(lang, 'play.prev'),
    blackout: translate(lang, 'play.blackout'),
    resume: translate(lang, 'play.blackoutExit'),
    timerReset: translate(lang, 'play.timerReset'),
    noNotes: translate(lang, 'play.noNotes'),
    slideOf: translate(lang, 'play.slideOf'),
    endOfDeck: translate(lang, 'play.endOfDeck'),
    syncHint: translate(lang, 'play.syncHint'),
    noChannel: translate(lang, 'play.noChannel'),
  }
}

/** 把 JSON 安全地塞进 `<script>`：转义 `<`，顺带打断 `</script>`。（导出以便单测） */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** 注入静态骨架时的 HTML 转义（deck 内容永远不走这里，只用于我们自己的 i18n 文案）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PRESENTER_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:#0a0b0e;color:#e8eaef;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;min-height:100%}
.bar{display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid #23262f;background:#0e1014}
.brand{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#c8a15a}
.count{font-family:ui-monospace,Consolas,monospace;font-size:14px;color:#e8eaef}
.status{margin-left:auto;font-size:11px;letter-spacing:.06em;padding:3px 8px;border-radius:99px;border:1px solid #343948;color:#a4aab8}
body[data-blackout="true"] .status{color:#0b0c10;background:#e4574f;border-color:#e4574f}
.grid{flex:1;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(240px,.8fr);gap:14px;padding:14px 18px;min-height:0}
.panel{background:#12141a;border:1px solid #23262f;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;min-height:0}
.panel h2{margin:0 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#737a8a;font-weight:600}
.notes{flex:1;overflow:auto;white-space:pre-wrap;font-size:17px;line-height:1.66;color:#e8eaef;overflow-wrap:anywhere}
.notes[data-empty="true"]{color:#737a8a;font-size:14px}
.side{display:flex;flex-direction:column;gap:10px;min-height:0}
.card{background:#12141a;border:1px solid #23262f;border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:4px}
.k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#737a8a}
.timer{font-family:ui-monospace,Consolas,monospace;font-size:30px;line-height:1.1;color:#e8eaef;font-variant-numeric:tabular-nums}
.v{font-size:14px;line-height:1.45;color:#e8eaef;overflow-wrap:anywhere}
.hint{font-size:11px;color:#737a8a}
.controls{display:flex;gap:8px;padding:12px 18px;border-top:1px solid #23262f;background:#0e1014}
button{appearance:none;border:1px solid #343948;background:#171a21;color:#e8eaef;border-radius:999px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}
button:hover{background:#222732}
button:active{transform:translateY(1px)}
button.primary{background:#c8a15a;border-color:#c8a15a;color:#0b0c10;font-weight:600}
button.primary:hover{background:#d3ae6c}
.toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:#1c2029;border:1px solid #343948;color:#e8eaef;font-size:12px;padding:6px 12px;border-radius:8px}
`

/** 讲者窗文档（纯静态骨架；所有动态内容由窗口内脚本用 textContent 填入）。 */
function presenterDoc(labels: PresenterLabels, lang: Lang): string {
  const L = jsonForScript(labels)
  const channel = jsonForScript(SYNC_CHANNEL)
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(labels.title)}</title>
<style>${PRESENTER_CSS}</style>
</head>
<body>
<header class="bar">
  <span class="brand">LUMEN</span>
  <span id="count" class="count">– / –</span>
  <span class="hint">${escapeHtml(labels.syncHint)}</span>
  <span id="status" class="status">${escapeHtml(labels.blackout)}</span>
</header>
<main class="grid">
  <section class="panel">
    <h2>${escapeHtml(labels.notes)}</h2>
    <div id="notes" class="notes" data-empty="false"></div>
  </section>
  <aside class="side">
    <div class="card"><span class="k">${escapeHtml(labels.timer)}</span><span id="timer" class="timer">0:00</span></div>
    <div class="card"><span class="k">${escapeHtml(labels.current)}</span><span id="title" class="v">–</span></div>
    <div class="card"><span class="k">${escapeHtml(labels.upNext)}</span><span id="nextTitle" class="v">–</span></div>
  </aside>
</main>
<footer class="controls">
  <button type="button" data-action="prev" id="btnPrev">${escapeHtml(labels.prev)}</button>
  <button type="button" data-action="next" class="primary" id="btnNext">${escapeHtml(labels.next)}</button>
  <button type="button" data-action="blackout" id="btnBlackout">${escapeHtml(labels.blackout)}</button>
  <button type="button" data-action="timer-reset" id="btnTimer">${escapeHtml(labels.timerReset)}</button>
</footer>
<script>
(function () {
  var L = ${L};
  var CHANNEL = ${channel};
  var state = null;
  var deck = null;
  var channel = null;

  function byId(id) { return document.getElementById(id); }
  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text == null ? '' : String(text);
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function clock(ms) {
    var total = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function slideLabel(i) {
    return L.slideOf.split('{n}').join(String(i + 1));
  }
  function render() {
    if (!state) return;
    var total = state.total || (deck ? deck.slides.length : 0);
    setText('count', (state.index + 1) + ' / ' + total);
    setText('timer', clock(state.elapsedMs));
    setText('status', state.blackout ? L.resume : L.blackout);
    document.body.setAttribute('data-blackout', state.blackout ? 'true' : 'false');
    var blackoutBtn = byId('btnBlackout');
    if (blackoutBtn) blackoutBtn.textContent = state.blackout ? L.resume : L.blackout;

    var current = deck && deck.slides ? deck.slides[state.index] : null;
    var next = deck && deck.slides ? deck.slides[state.index + 1] : null;
    setText('title', current && current.name ? current.name : slideLabel(state.index));
    setText('notes', current && current.notes ? current.notes : L.noNotes);
    var notesEl = byId('notes');
    if (notesEl) notesEl.setAttribute('data-empty', current && current.notes ? 'false' : 'true');
    setText('nextTitle', next ? (next.name || slideLabel(state.index + 1)) : L.endOfDeck);
  }
  function send(msg) {
    if (!channel) return;
    try { channel.postMessage(msg); } catch (err) { /* 关窗瞬间的竞态，忽略 */ }
  }
  function onMessage(event) {
    var msg = event.data || {};
    if (msg.type === 'state') { state = msg; render(); }
    else if (msg.type === 'deck') { deck = msg; render(); }
  }
  function boot() {
    if (typeof BroadcastChannel !== 'function') {
      setText('notes', L.noChannel);
      return;
    }
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = onMessage;
    channel.postMessage({ type: 'hello' });
  }
  document.addEventListener('click', function (event) {
    var el = event.target;
    while (el && el !== document.body) {
      var action = el.getAttribute ? el.getAttribute('data-action') : null;
      if (action) {
        if (action === 'go') send({ type: 'command', action: 'go', index: Number(el.getAttribute('data-index')) });
        else send({ type: 'command', action: action });
        return;
      }
      el = el.parentNode;
    }
  });
  window.addEventListener('beforeunload', function () {
    if (channel) { try { channel.close(); } catch (err) {} }
  });
  boot();
})();
</script>
</body>
</html>`
}

/** 打开讲者窗；被浏览器拦截时返回 null（调用方负责 toast）。 */
export function openPresenterWindow(lang: Lang): Window | null {
  let win: Window | null = null
  try {
    win = window.open('', 'lumen-presenter', WINDOW_FEATURES)
  } catch {
    return null
  }
  if (!win) return null
  const labels = labelsFor(lang)
  const html = presenterDoc(labels, lang)
  try {
    const doc = win.document
    doc.open()
    doc.write(html)
    doc.close()
  } catch {
    // 写文档失败（极端情况下的跨源/权限问题）：把窗口收掉，按"打不开"处理。
    try {
      win.close()
    } catch {
      /* noop */
    }
    return null
  }
  return win
}
