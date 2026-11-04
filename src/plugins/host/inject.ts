/**
 * plugins/host/inject.ts —— 沙箱帧客户端 bootstrap（02 §4.3 / §5.3；samples 的插件代码直接依赖）。
 *
 * 产物是一段**无闭包外泄**的 IIFE（不是 `eval`，作为文档内联脚本由 `frameDoc.ts` 注入），顺序：
 * 1. 读 `window.__LUMEN_BOOT__`（`frameDoc.ts#composeBootData` 生成，`</script` 已转义）；
 * 2. 建立 RPC 传输（pending Map / `f<seq>` 请求 id / 8s 超时 / 事件队列 / 心跳回包）；
 * 3. 构造 `window.lumen`：17 个命名空间；`meta` 与整体 `Object.freeze`（防插件改写宿主方法引用）；
 * 4. `ui.onRender` 在 DOMContentLoaded 与每次 `env` 变化时重入，`fn` 抛错 → `E-RUN-01` 上报；
 * 5. `error`/`unhandledrejection` → `evt __error`；模块 `load` 后（含 TLA）→ `evt __ready`；
 * 6. 源码静态预检（03 §6.3）的唯一实现是 `manifest.ts#scanSource`，这里只做**转发导出**，不复制正则表。
 *
 * 纪律：客户端只是消息封装，**不做任何授权判定**；能力网关在宿主侧逐方法实时校验（02 §5.1）。
 */
import { FRAME_REQUEST_TIMEOUT_MS } from '../types'
import { FRAME_CSS_MAX_BYTES, type FrameBootData } from './frameDoc'

/* ------------------------------------------------------------------ */
/* 静态预检：唯一实现留在 manifest.ts（安装期 E-MAN-12），此处只转发   */
/* ------------------------------------------------------------------ */

export {
  FORBIDDEN_SOURCE_PATTERNS,
  scanSource,
  assertSourceSafe,
} from '../manifest'
export type { ForbiddenHit } from '../manifest'

/** 客户端与宿主协议版本（`FrameMessage.v`；02 §4.4 冻结为 1）。 */
export const FRAME_CLIENT_VERSION = 1

/* ------------------------------------------------------------------ */
/* bootstrap 源码                                                     */
/* ------------------------------------------------------------------ */

/**
 * 生成帧内 bootstrap IIFE 源码。
 *
 * 注意：这是**字符串**，任何对 `FrameBootData` 的依赖都通过 `window.__LUMEN_BOOT__` 在运行时读取，
 * 因此 bootstrap 本身对宿主构建无副作用、可在单测里断言关键片段。
 */
export function composeBootstrapScript(): string {
  const REQ_TIMEOUT = FRAME_REQUEST_TIMEOUT_MS
  const CSS_MAX = FRAME_CSS_MAX_BYTES
  return `(function () {
  'use strict';
  var BOOT = (typeof window !== 'undefined' && window.__LUMEN_BOOT__) || null;
  if (!BOOT || BOOT.v !== 1 || !BOOT.pluginId) return;
  var PLUGIN_ID = BOOT.pluginId;
  var NONCE = BOOT.frameNonce;
  var REQ_TIMEOUT = ${REQ_TIMEOUT};
  var CSS_MAX = ${CSS_MAX};
  var EVENT_QUEUE_MAX = 200;
  var state = {
    seq: 0,
    pending: new Map(),
    ready: false,
    bootFailed: false,
    destroyed: false,
    renderFns: [],
    commands: new Map(),
    ruleRuns: new Map(),
    deckSubs: [],
    themeSubs: [],
    settingsSubs: [],
    eventSubs: Object.create(null),
    queued: [],
    settingsValues: {},
    env: {
      locale: BOOT.locale === 'en' ? 'en' : 'zh',
      uiTheme: 'dark',
      reducedMotion: false,
      tokens: BOOT.tokens || {},
      themeId: '',
      theme: null,
      width: 0,
      height: 0
    },
    i18nRelative: { zh: Object.assign({}, (BOOT.i18n && BOOT.i18n.zh) || {}), en: Object.assign({}, (BOOT.i18n && BOOT.i18n.en) || {}) },
    i18nPrefixed: { zh: Object.create(null), en: Object.create(null) },
    root: null,
    abort: null
  };

  function noop() {}

  function fail(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  function post(type, method, payload, id) {
    var message = { v: 1, id: id, type: type, pluginId: PLUGIN_ID, frameNonce: NONCE };
    if (method) message.method = method;
    if (payload !== undefined) message.payload = payload;
    try { parent.postMessage(message, '*'); } catch (error) { /* 帧正在销毁 */ }
  }

  function respond(id, ok, payload, code, message) {
    var result = { v: 1, id: id, type: ok ? 'res' : 'err', pluginId: PLUGIN_ID, frameNonce: NONCE };
    if (ok) {
      if (payload !== undefined) result.payload = payload;
    } else {
      result.code = code || 'E-HOST-01';
      result.message = String(message || code || '').slice(0, 300);
    }
    try { parent.postMessage(result, '*'); } catch (error) { /* noop */ }
  }

  function request(method, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'f' + (state.seq++);
      var timer = setTimeout(function () {
        state.pending.delete(id);
        reject(fail('E-ABI-05', 'request timeout: ' + method));
      }, REQ_TIMEOUT);
      state.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post('req', method, payload, id);
    });
  }

  /* ---------------------------- 事件 ---------------------------- */

  function addSub(list, fn) {
    if (typeof fn !== 'function') return noop;
    list.push(fn);
    return function () {
      var index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    };
  }

  function dispatchEvent(name, payload) {
    var list = state.eventSubs[name];
    if (!list || list.length === 0) return;
    for (var i = 0; i < list.length; i += 1) {
      try { list[i](payload); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
  }

  function notifyDeckSubs(change) {
    for (var i = 0; i < state.deckSubs.length; i += 1) {
      try { state.deckSubs[i](change); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
  }

  function notifyThemeSubs(themeId) {
    for (var i = 0; i < state.themeSubs.length; i += 1) {
      try { state.themeSubs[i](themeId); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
  }

  function notifySettingsSubs() {
    for (var i = 0; i < state.settingsSubs.length; i += 1) {
      try { state.settingsSubs[i](state.settingsValues); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
  }

  function reportError(error, fallbackCode) {
    var code = (error && error.code) || fallbackCode || 'E-RUN-01';
    var message = '';
    var stack = '';
    try {
      message = String((error && error.message) || error || '').slice(0, 300);
      stack = String((error && error.stack) || '').slice(0, 2000);
    } catch (ignored) { /* noop */ }
    post('evt', '__error', { code: code, message: message, stack: stack });
  }

  /* ---------------------------- 环境 ---------------------------- */

  function applyEnv(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.locale === 'en' || payload.locale === 'zh') state.env.locale = payload.locale;
    if (payload.lang === 'en' || payload.lang === 'zh') state.env.lang = payload.lang;
    if (payload.uiTheme === 'light' || payload.uiTheme === 'dark') state.env.uiTheme = payload.uiTheme;
    if (typeof payload.reducedMotion === 'boolean') state.env.reducedMotion = payload.reducedMotion;
    if (typeof payload.width === 'number') state.env.width = payload.width;
    if (typeof payload.height === 'number') state.env.height = payload.height;
    if (typeof payload.themeId === 'string') state.env.themeId = payload.themeId;
    if (payload.theme && typeof payload.theme === 'object') state.env.theme = payload.theme;
    if (payload.tokens && typeof payload.tokens === 'object') {
      state.env.tokens = payload.tokens;
    }
    paintEnv();
    if (payload.render !== false) renderAll();
  }

  function paintEnv() {
    var html = document.documentElement;
    if (!html) return;
    html.setAttribute('data-lang', state.env.locale);
    html.setAttribute('data-ui-theme', state.env.uiTheme);
    html.setAttribute('data-reduced-motion', state.env.reducedMotion ? 'true' : 'false');
    var tokens = state.env.tokens || {};
    for (var name in tokens) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
      if (!/^--[a-z0-9-]+$/i.test(name)) continue;
      try { html.style.setProperty(name, String(tokens[name])); } catch (error) { /* noop */ }
    }
  }

  /* ---------------------------- i18n ---------------------------- */

  function lookupI18n(lang, key) {
    var primary = lang === 'en' ? 'en' : 'zh';
    var secondary = primary === 'zh' ? 'en' : 'zh';
    var prefixedKey = key.indexOf('plugin.') === 0 ? key : 'plugin.' + PLUGIN_ID + '.' + key;
    var prefixed = state.i18nPrefixed;
    if (prefixed[primary] && prefixed[primary][prefixedKey] !== undefined) return prefixed[primary][prefixedKey];
    if (prefixed[secondary] && prefixed[secondary][prefixedKey] !== undefined) return prefixed[secondary][prefixedKey];
    var relativeKey = key.indexOf('plugin.' + PLUGIN_ID + '.') === 0 ? key.slice(PLUGIN_ID.length + 8) : key;
    var relative = state.i18nRelative;
    if (relative[primary] && relative[primary][relativeKey] !== undefined) return relative[primary][relativeKey];
    if (relative[secondary] && relative[secondary][relativeKey] !== undefined) return relative[secondary][relativeKey];
    return undefined;
  }

  function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\\{(\\w+)\\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }

  function t(key, vars) {
    if (typeof key !== 'string' || key === '') return '';
    var found = lookupI18n(state.env.locale, key);
    return found === undefined ? key : interpolate(found, vars);
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function ensureRoot() {
    if (state.root && state.root.isConnected) return state.root;
    state.root = document.getElementById('lumen-root');
    return state.root;
  }

  function renderContext() {
    return {
      width: state.env.width || (ensureRoot() ? ensureRoot().clientWidth : 0),
      height: state.env.height || (ensureRoot() ? ensureRoot().clientHeight : 0),
      themeId: state.env.themeId,
      theme: state.env.theme || { id: state.env.themeId, name: { zh: '', en: '' }, colors: {} },
      locale: state.env.locale,
      signal: state.abort ? state.abort.signal : new AbortController().signal,
      slot: BOOT.slot,
      slotId: BOOT.slot,
      contributionId: BOOT.contributionId,
      kind: BOOT.kind,
      frameKind: BOOT.kind,
      id: BOOT.contributionId,
      tokens: state.env.tokens
    };
  }

  function renderAll() {
    var root = ensureRoot();
    if (!root) return;
    if (state.abort) {
      try { state.abort.abort(); } catch (error) { /* noop */ }
    }
    state.abort = typeof AbortController === 'function' ? new AbortController() : null;
    var ctx = renderContext();
    for (var i = 0; i < state.renderFns.length; i += 1) {
      try {
        state.renderFns[i](root, ctx);
      } catch (error) {
        reportError(error, 'E-RUN-01');
      }
    }
  }

  /* ---------------------------- host → plugin 请求 ---------------------------- */

  function invokeLocalCommand(payload) {
    var id = payload && payload.id;
    var runner = state.commands.get(id);
    if (typeof runner !== 'function') return Promise.reject(fail('E-ABI-01', 'unknown plugin command'));
    return Promise.resolve().then(function () { return runner(payload ? payload.args : undefined); });
  }

  var hostHandlers = {
    __invoke: invokeLocalCommand,
    __runRule: function (payload) {
      var id = payload && payload.id;
      var run = state.ruleRuns.get(id);
      if (typeof run !== 'function') return Promise.reject(fail('E-ABI-01', 'unknown lint rule'));
      return Promise.resolve().then(function () { return run(payload ? payload.ctx : undefined); });
    },
    __runRecipe: function (payload) {
      var build = state.recipeBuilds && state.recipeBuilds.get(payload && payload.id);
      if (typeof build !== 'function') return Promise.reject(fail('E-ABI-01', 'unknown plugin recipe'));
      return Promise.resolve().then(function () {
        return build(payload.content, payload.themeId);
      });
    },
    __preflight: function (payload) {
      var fn = state.preflights && state.preflights[0];
      if (typeof fn !== 'function') return Promise.resolve([]);
      return Promise.resolve().then(function () { return fn(payload ? payload.ctx : undefined); });
    },
    __provideAssets: function () {
      var fn = state.assetProviders && state.assetProviders[0];
      if (typeof fn !== 'function') return Promise.resolve([]);
      return Promise.resolve().then(function () { return fn(); });
    },
    __render: function () { renderAll(); return null; },
    __settings: function (payload) {
      state.settingsValues = (payload && payload.values) || {};
      notifySettingsSubs();
      return null;
    }
  };

  function handleHostRequest(data) {
    var handler = hostHandlers[data.method];
    var promise;
    try {
      promise = handler ? Promise.resolve(handler(data.payload)) : Promise.reject(fail('E-ABI-01', 'unknown host method'));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(function (result) { respond(data.id, true, result); }, function (error) {
      respond(data.id, false, undefined, (error && error.code) || 'E-RUN-01', (error && error.message) || 'plugin error');
    });
  }

  /* ---------------------------- 宿主事件 ---------------------------- */

  function handleEvent(data) {
    var method = data.method || '';
    var payload = data.payload;
    if (method === '__ping') {
      post('evt', '__pong', { id: data.id, at: Date.now() });
      return;
    }
    if (method === 'env') {
      applyEnv(payload);
      return;
    }
    if (method === '__settings') {
      state.settingsValues = (payload && payload.values) || {};
      notifySettingsSubs();
      return;
    }
    if (method === '__invoke') {
      handleHostRequest({ id: data.id, method: '__invoke', payload: payload });
      return;
    }
    if (method === '__render') {
      renderAll();
      return;
    }
    if (method === 'deck:change' || method === 'deck:open') {
      notifyDeckSubs(payload);
      dispatchEvent(method, payload);
      return;
    }
    if (method === 'theme:change') {
      if (payload && typeof payload.themeId === 'string') state.env.themeId = payload.themeId;
      notifyThemeSubs(payload && payload.themeId);
      dispatchEvent(method, payload);
      return;
    }
    if (method === 'slide:change' || method === 'mode:change' || method === 'play:start' || method === 'play:stop' || method === 'export:before' || method === 'export:after' || method === 'app:ready') {
      dispatchEvent(method, payload);
      return;
    }
    if (method === 'destroy') {
      teardown();
    }
  }

  function onMessage(event) {
    if (state.destroyed) return;
    if (typeof window !== 'undefined' && event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.v !== 1) return;
    if (data.pluginId !== PLUGIN_ID || data.frameNonce !== NONCE) return;
    if (data.type === 'res' || data.type === 'err') {
      var entry = state.pending.get(data.id);
      if (!entry) return;
      state.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.type === 'err') entry.reject(fail(data.code || 'E-HOST-01', data.message));
      else entry.resolve(data.payload);
      return;
    }
    if (data.type === 'req') {
      handleHostRequest(data);
      return;
    }
    if (data.type === 'evt') handleEvent(data);
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  function flushQueue() {
    var queued = state.queued;
    state.queued = [];
    for (var i = 0; i < queued.length; i += 1) {
      try { handleEvent(queued[i]); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
  }

  function onDomReady() {
    // 模块求值期抛错/语法错时，DOMContentLoaded 仍会触发：先判哨兵（确定性），
    // 避免把 onRender 抛出的 E-RUN-01 当成「首次异常」而错过启动失败计数（02 §3.5）。
    if (!window.__LUMEN_PLUGIN_EVALUATED__) {
      markBootFailure(null, 'plugin entry did not finish evaluation');
      return;
    }
    applyEnv({ render: false });
    flushQueue();
    renderAll();
  }

  function onLoad() {
    // 02 §4.3 第 5 条：__ready 只在插件模块 import 完成（含顶层 await）后发出。
    if (state.ready || state.bootFailed) return;
    // 模块顶层抛错时 window error 事件的派发不保证早于 load，因此以 frameDoc 追加的
    // 「求值完成哨兵」为准：哨兵缺失 = 模块未跑完 → 发 E-RUN-02（宿主计失败/隔离），不发 ready。
    if (!window.__LUMEN_PLUGIN_EVALUATED__) {
      markBootFailure(null, 'plugin entry did not finish evaluation');
      return;
    }
    state.ready = true;
    post('evt', '__ready', {
      apiVersion: BOOT.apiVersion,
      hasRender: state.renderFns.length > 0,
      at: Date.now()
    });
    dispatchEvent('app:ready', { appVersion: BOOT.appVersion, locale: state.env.locale });
  }

  function teardown() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.pending.forEach(function (entry) { clearTimeout(entry.timer); try { entry.reject(fail('E-HOST-03', 'frame destroyed')); } catch (error) { /* noop */ } });
    state.pending.clear();
    if (state.abort) { try { state.abort.abort(); } catch (error) { /* noop */ } }
  }

  /** 启动期异常：模块 import 未完成 → 不发 ready，改发 E-RUN-02（宿主计失败/隔离，02 §3.5 / §4.3）。 */
  function markBootFailure(error, message) {
    if (state.ready || state.bootFailed) return false;
    state.bootFailed = true;
    var text = '';
    try {
      text = String((error && error.message) || message || 'plugin boot failed').slice(0, 300);
    } catch (ignored) {
      text = 'plugin boot failed';
    }
    post('evt', '__error', { code: 'E-RUN-02', message: text, stack: '' });
    return true;
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('DOMContentLoaded', onDomReady);
  window.addEventListener('load', onLoad);
  window.addEventListener('error', function (event) {
    var message = (event && event.message) || 'uncaught error';
    if (markBootFailure(event && event.error, message)) return;
    reportError({ code: 'E-RUN-01', message: message, stack: '' }, 'E-RUN-01');
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    if (markBootFailure(reason, (reason && reason.message) || 'unhandled rejection during boot')) return;
    reportError(reason || { code: 'E-RUN-01', message: 'unhandled rejection' }, 'E-RUN-01');
  });

  /* ---------------------------- 17 个命名空间 ---------------------------- */

  var lumen = {};

  var meta = {};
  Object.defineProperty(meta, 'pluginId', { value: PLUGIN_ID, enumerable: true });
  Object.defineProperty(meta, 'pluginVersion', { value: BOOT.pluginVersion, enumerable: true });
  Object.defineProperty(meta, 'apiVersion', { value: BOOT.apiVersion, enumerable: true });
  Object.defineProperty(meta, 'appVersion', { value: BOOT.appVersion, enumerable: true });
  Object.defineProperty(meta, 'capabilities', { value: Object.freeze((BOOT.capabilities || []).slice()), enumerable: true });
  Object.defineProperty(meta, 'locale', { get: function () { return state.env.locale; }, enumerable: true });
  Object.defineProperty(meta, 'slot', { value: BOOT.slot, enumerable: true });
  Object.defineProperty(meta, 'contributionId', { value: BOOT.contributionId, enumerable: true });
  lumen.meta = Object.freeze(meta);

  /* ---- ui ---- */

  var BLOCKED_TAGS = { script: 1, iframe: 1, object: 1, embed: 1, base: 1, link: 1, meta: 1, form: 1 };

  function uiEl(tag) {
    if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(tag)) throw fail('E-ABI-02', 'invalid element tag');
    if (BLOCKED_TAGS[tag]) throw fail('E-ABI-02', 'element tag is not allowed');
    var node = document.createElement(tag);
    var props = arguments[1];
    if (props) {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (key === 'text') continue;
        if (key === 'class' || key === 'className') { node.className = String(value); continue; }
        if (key === 'style' && value && typeof value === 'object') {
          for (var prop in value) {
            if (Object.prototype.hasOwnProperty.call(value, prop)) node.style.setProperty(prop, String(value[prop]));
          }
          continue;
        }
        if (key.indexOf('data-') === 0 || key.indexOf('aria-') === 0) { node.setAttribute(key, String(value)); continue; }
        if (typeof value === 'boolean') {
          if (value) node.setAttribute(key, '');
          else node.removeAttribute(key);
          continue;
        }
        if (value === null || value === undefined) continue;
        node.setAttribute(key, String(value));
      }
    }
    var children = Array.prototype.slice.call(arguments, 2);
    if (children.length > 0) {
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (child === null || child === undefined) continue;
        node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
      }
    } else if (props && typeof props.text === 'string') {
      node.textContent = props.text;
    }
    return node;
  }

  function uiCss(text) {
    if (typeof text !== 'string') throw fail('E-ABI-02', 'css() expects a string');
    if (text.length > CSS_MAX) throw fail('E-ABI-02', 'css() exceeds 64KB');
    var style = document.createElement('style');
    style.textContent = text;
    style.setAttribute('data-lumen-plugin-style', PLUGIN_ID);
    (document.head || document.documentElement).appendChild(style);
  }

  function uiOnRender(fn) {
    if (typeof fn !== 'function') throw fail('E-ABI-02', 'onRender() expects a function');
    state.renderFns.push(fn);
    // 只在 ready 之后才**同步**重入；启动期（模块求值途中）注册的渲染一律等到 DOMContentLoaded/__ready，
    // 否则插件的渲染回调在 boot 期抛错会先于「模块未跑完」的判定产生 E-RUN-01 噪声（E-40-10 口径）。
    if (state.ready) {
      try { fn(ensureRoot(), renderContext()); } catch (error) { reportError(error, 'E-RUN-01'); }
    }
    return function () {
      var index = state.renderFns.indexOf(fn);
      if (index >= 0) state.renderFns.splice(index, 1);
    };
  }

  lumen.ui = {
    el: uiEl,
    css: uiCss,
    onRender: uiOnRender,
    setTitle: function (title) { return request('ui.setTitle', { title: String(title == null ? '' : title).slice(0, 40) }); },
    openDialog: function (opts) { return request('ui.openDialog', normalizeOpen(opts)); },
    openPanel: function (opts) { return request('ui.openPanel', normalizeOpen(opts)); },
    closePanel: function (opts) {
      var payload = opts && typeof opts === 'object' ? { slot: opts.slot, id: opts.id } : {};
      return request('ui.closePanel', payload).catch(noop);
    },
    setBusy: function (busy, label) {
      return request('ui.setBusy', { busy: busy === true, label: label == null ? '' : String(label).slice(0, 40) }).catch(noop);
    }
  };

  function normalizeOpen(opts) {
    if (!opts || typeof opts !== 'object') throw fail('E-ABI-02', 'open expects an object');
    return {
      id: String(opts.id || ''),
      title: String(opts.title || '').slice(0, 80),
      size: opts.size === 'sm' || opts.size === 'md' || opts.size === 'lg' ? opts.size : undefined,
      slot: typeof opts.slot === 'string' ? opts.slot : undefined
    };
  }

  /* ---- commands ---- */

  function normalizeTitle(title) {
    if (typeof title === 'string') return { zh: title, en: title };
    if (title && typeof title === 'object') return { zh: String(title.zh || title.en || ''), en: String(title.en || title.zh || '') };
    return { zh: '', en: '' };
  }

  lumen.commands = {
    register: function (cmd) {
      if (!cmd || typeof cmd.id !== 'string' || cmd.id === '') throw fail('E-ABI-02', 'command id is required');
      if (typeof cmd.run !== 'function') throw fail('E-ABI-02', 'command run must be a function');
      if (state.commands.has(cmd.id)) throw fail('E-ABI-02', 'command id is already registered');
      state.commands.set(cmd.id, cmd.run);
      request('commands.register', { id: cmd.id, title: normalizeTitle(cmd.title) }).catch(function (error) {
        state.commands.delete(cmd.id);
        reportError(error, 'E-ABI-02');
      });
      return function () {
        state.commands.delete(cmd.id);
        request('commands.unregister', { id: cmd.id }).catch(noop);
      };
    },
    unregister: function (id) {
      state.commands.delete(id);
      return request('commands.unregister', { id: String(id) }).then(function () {}, noop);
    },
    invoke: function (id, args) {
      if (typeof id !== 'string' || id === '') return Promise.reject(fail('E-ABI-02', 'command id is required'));
      if (state.commands.has(id)) return invokeLocalCommand({ id: id, args: args });
      return request('commands.invoke', { id: id, args: args });
    }
  };

  /* ---- keymap ---- */

  lumen.keymap = {
    bind: function (combo, commandId) {
      return request('keymap.bind', { combo: String(combo || ''), commandId: String(commandId || '') });
    },
    unbind: function (combo) {
      return request('keymap.unbind', { combo: String(combo || '') }).catch(noop);
    }
  };

  /* ---- layout ---- */

  var layoutPresets = Object.create(null);

  lumen.layout = {
    registerPreset: function (preset) {
      if (!preset || typeof preset.id !== 'string' || preset.id === '') throw fail('E-ABI-02', 'layout preset id is required');
      if (!preset.apply || typeof preset.apply !== 'object') throw fail('E-ABI-02', 'layout preset apply object is required');
      layoutPresets[preset.id] = preset;
      request('layout.registerPreset', { id: preset.id, name: normalizeTitle(preset.name), apply: preset.apply }).catch(function (error) {
        delete layoutPresets[preset.id];
        reportError(error, 'E-ABI-02');
      });
      return function () {
        delete layoutPresets[preset.id];
        request('layout.registerPreset', { id: preset.id, remove: true }).catch(noop);
      };
    },
    apply: function (presetId) { return request('layout.apply', { presetId: String(presetId || '') }); },
    current: function () { return request('layout.current', {}); }
  };

  /* ---- deck ---- */

  var deckEventNames = ['deck:change', 'slide:change', 'deck:open'];

  lumen.deck = {
    getSnapshot: function () { return request('deck.getSnapshot', {}); },
    getActiveSlide: function () { return request('deck.getActiveSlide', {}); },
    subscribe: function (listener) { return addSub(state.deckSubs, listener); },
    insertBlocks: function (slideId, blocks) { return request('deck.insertBlocks', { slideId: slideId == null ? null : String(slideId), blocks: blocks }); },
    updateBlock: function (blockId, patch) { return request('deck.updateBlock', { blockId: String(blockId || ''), patch: patch }); },
    transaction: function (label, fn) {
      if (typeof fn !== 'function') throw fail('E-ABI-02', 'transaction label must be a function');
      var token = 'tx' + (state.seq++);
      return request('deck.transaction', { phase: 'begin', label: String(label || '').slice(0, 40), token: token })
        .then(function () { return fn(); })
        .then(function () { return request('deck.transaction', { phase: 'commit', token: token }); }, function (error) {
          return request('deck.transaction', { phase: 'rollback', token: token }).catch(noop).then(function () { throw error; });
        });
    },
    applyTheme: function (themeId) { return request('deck.applyTheme', { themeId: String(themeId || '') }); }
  };

  /* ---- theme ---- */

  lumen.theme = {
    get: function () { return request('theme.get', {}); },
    cssVars: function () { return request('theme.cssVars', {}); },
    subscribe: function (listener) { return addSub(state.themeSubs, listener); }
  };

  /* ---- storage ---- */

  lumen.storage = {
    get: function (key) { return request('storage.get', { key: String(key || '') }); },
    set: function (key, value) { return request('storage.set', { key: String(key || ''), value: value }); },
    remove: function (key) { return request('storage.remove', { key: String(key || '') }); },
    keys: function () { return request('storage.keys', {}); },
    clear: function () { return request('storage.clear', {}); }
  };

  /* ---- settings ---- */

  lumen.settings = {
    declare: function (fields) { return request('settings.declare', { fields: fields }); },
    get: function () { return request('settings.get', {}); },
    patch: function (patch) { return request('settings.patch', { patch: patch }); },
    reset: function () { return request('settings.reset', {}); },
    subscribe: function (listener) { return addSub(state.settingsSubs, listener); }
  };

  /* ---- i18n ---- */

  var i18n = {
    t: t,
    register: function (pack) { return request('i18n.register', pack || {}); }
  };
  Object.defineProperty(i18n, 'locale', { get: function () { return state.env.locale; }, enumerable: true });
  lumen.i18n = i18n;

  /* ---- lint ---- */

  function parseColor(input) {
    if (typeof input !== 'string') return null;
    var value = input.trim();
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (hex) {
      var raw = hex[1];
      if (raw.length === 3) raw = raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2];
      return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16), b: parseInt(raw.slice(4, 6), 16), a: 1 };
    }
    var rgb = /^rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$/i.exec(value);
    if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
    return null;
  }

  function luminance(color) {
    function channel(value) {
      var c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrastRatio(foreground, background) {
    var fg = parseColor(foreground);
    var bg = parseColor(background);
    if (!fg || !bg) return null;
    var blended = fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
    var l1 = luminance(blended);
    var l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function aaThreshold(fontSize, fontWeight) {
    var large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    return large ? 3 : 4.5;
  }

  function plainText(source) {
    if (typeof source !== 'string') return '';
    return source
      .replace(/!\\[[^\\]]*\\]\\([^)]*\\)/g, ' ')
      .replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1')
      .replace(/[*_~\\x60#>]/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function estimateTextLayout(input) {
    var text = String((input && input.text) || '');
    var width = Math.max(1, Number(input && input.width) || 1);
    var height = Math.max(1, Number(input && input.height) || 1);
    var fontSize = Math.max(1, Number(input && input.fontSize) || 16);
    var lineHeight = Math.max(0.5, Number(input && input.lineHeight) || 1.4);
    var chars = Array.from(text.replace(/\\s+/g, ' ').trim()).length;
    var charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.56)));
    var lines = chars === 0 ? 0 : Math.ceil(chars / charsPerLine);
    var contentHeight = lines * fontSize * lineHeight;
    return { lines: lines, maxLineWidth: width, contentHeight: contentHeight, ratio: contentHeight / height };
  }

  function readingSeconds(text, lang) {
    var plain = plainText(text);
    if (plain === '') return 0;
    if (lang === 'en') return plain.split(/\\s+/).filter(Boolean).length / 2.6;
    return plain.replace(/\\s+/g, '').length / 4.2;
  }

  lumen.lint = {
    helpers: Object.freeze({ plainText: plainText, contrastRatio: contrastRatio, aaThreshold: aaThreshold, estimateTextLayout: estimateTextLayout, readingSeconds: readingSeconds }),
    registerRule: function (rule) {
      if (!rule || typeof rule.id !== 'string' || rule.id === '') throw fail('E-ABI-02', 'lint rule id is required');
      if (typeof rule.run !== 'function') throw fail('E-ABI-02', 'lint rule run must be a function');
      state.ruleRuns.set(rule.id, rule.run);
      request('lint.registerRule', { id: rule.id, title: normalizeTitle(rule.title), severity: rule.severity }).catch(function (error) {
        state.ruleRuns.delete(rule.id);
        reportError(error, 'E-ABI-02');
      });
      return function () {
        state.ruleRuns.delete(rule.id);
        request('lint.registerRule', { id: rule.id, remove: true }).catch(noop);
      };
    },
    report: function (findings) { return request('lint.report', { findings: findings }); }
  };

  /* ---- ai ---- */

  state.recipeBuilds = new Map();

  lumen.ai = {
    complete: function (req) {
      if (!req || typeof req.system !== 'string' || typeof req.user !== 'string') {
        return Promise.reject(fail('E-ABI-02', 'ai.complete requires system and user strings'));
      }
      return request('ai.complete', {
        system: String(req.system).slice(0, 20000),
        user: String(req.user).slice(0, 20000),
        json: req.json === true,
        temperature: typeof req.temperature === 'number' ? req.temperature : undefined,
        task: req.task === 'plugin' ? 'plugin' : undefined
      });
    },
    registerRecipe: function (recipe) {
      if (!recipe || typeof recipe.id !== 'string' || typeof recipe.namespace !== 'string') throw fail('E-ABI-02', 'recipe id/namespace required');
      if (typeof recipe.build !== 'function') throw fail('E-ABI-02', 'recipe build must be a function');
      state.recipeBuilds.set(recipe.id, recipe.build);
      request('ai.registerRecipe', { id: recipe.id, namespace: recipe.namespace, title: normalizeTitle(recipe.title) }).catch(function (error) {
        state.recipeBuilds.delete(recipe.id);
        reportError(error, 'E-ABI-02');
      });
      return function () {
        state.recipeBuilds.delete(recipe.id);
        request('ai.registerRecipe', { id: recipe.id, namespace: recipe.namespace, remove: true }).catch(noop);
      };
    },
    registerPromptFragment: function (fragment) {
      if (!fragment || typeof fragment.id !== 'string' || typeof fragment.text !== 'string') throw fail('E-ABI-02', 'prompt fragment id/text required');
      request('ai.registerPromptFragment', {
        id: fragment.id,
        title: normalizeTitle(fragment.title),
        text: String(fragment.text).slice(0, 4000),
        tasks: Array.isArray(fragment.tasks) ? fragment.tasks.slice(0, 4) : []
      }).catch(function (error) { reportError(error, 'E-ABI-02'); });
      return function () { request('ai.registerPromptFragment', { id: fragment.id, remove: true }).catch(noop); };
    }
  };

  /* ---- assets ---- */

  lumen.assets = {
    put: function (input) {
      if (!input || typeof input.dataUrl !== 'string') return Promise.reject(fail('E-ABI-02', 'asset dataUrl is required'));
      return request('assets.put', { name: String(input.name || ''), mime: String(input.mime || ''), dataUrl: input.dataUrl });
    },
    getUrl: function (assetId) { return request('assets.getUrl', { assetId: String(assetId || '') }); },
    remove: function (assetId) { return request('assets.remove', { assetId: String(assetId || '') }); },
    list: function () { return request('assets.list', {}); }
  };

  /* ---- export ---- */

  state.preflights = [];
  state.assetProviders = [];

  lumen.export = {
    onPreflight: function (fn) {
      if (typeof fn !== 'function') throw fail('E-ABI-02', 'onPreflight expects a function');
      state.preflights.push(fn);
      request('export.onPreflight', { kind: 'preflight' }).catch(function (error) { reportError(error, 'E-ABI-02'); });
      return function () {
        var index = state.preflights.indexOf(fn);
        if (index >= 0) state.preflights.splice(index, 1);
        request('export.onPreflight', { kind: 'preflight', remove: true }).catch(noop);
      };
    },
    provideStaticAssets: function (fn) {
      if (typeof fn !== 'function') throw fail('E-ABI-02', 'provideStaticAssets expects a function');
      state.assetProviders.push(fn);
      request('export.provideStaticAssets', {}).catch(function (error) { reportError(error, 'E-ABI-02'); });
      return function () {
        var index = state.assetProviders.indexOf(fn);
        if (index >= 0) state.assetProviders.splice(index, 1);
        request('export.provideStaticAssets', { remove: true }).catch(noop);
      };
    }
  };

  /* ---- events ---- */

  lumen.events = {
    on: function (name, listener) {
      if (typeof name !== 'string' || typeof listener !== 'function') throw fail('E-ABI-02', 'events.on(name, fn)');
      if (!state.eventSubs[name]) state.eventSubs[name] = [];
      state.eventSubs[name].push(listener);
      return function () { lumen.events.off(name, listener); };
    },
    off: function (name, listener) {
      var list = state.eventSubs[name];
      if (!list) return;
      var index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }
  };

  /* ---- notify ---- */

  var lastToastAt = 0;
  lumen.notify = {
    toast: function (opts) {
      if (!opts || typeof opts !== 'object') return;
      var now = Date.now();
      if (now - lastToastAt < 1000) return;
      lastToastAt = now;
      var kind = opts.kind === 'success' || opts.kind === 'error' ? opts.kind : 'info';
      request('notify.toast', { kind: kind, message: String(opts.message || '').slice(0, 160), ttl: typeof opts.ttl === 'number' ? opts.ttl : undefined }).catch(noop);
    }
  };

  /* ---- log ---- */

  function logAt(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i += 1) {
      try {
        var value = args[i];
        parts.push(typeof value === 'string' ? value : JSON.stringify(value));
      } catch (error) { parts.push(String(args[i])); }
    }
    var message = parts.join(' ').slice(0, 500);
    try { if (console && console[level]) console[level]('[plugin:' + PLUGIN_ID + ']', message); } catch (ignored) { /* noop */ }
    post('evt', '__log', { level: level, message: message });
  }

  lumen.log = {
    debug: function () { logAt('debug', arguments); },
    info: function () { logAt('info', arguments); },
    warn: function () { logAt('warn', arguments); },
    error: function () { logAt('error', arguments); }
  };

  Object.freeze(lumen.ui);
  Object.freeze(lumen.commands);
  Object.freeze(lumen.keymap);
  Object.freeze(lumen.layout);
  Object.freeze(lumen.deck);
  Object.freeze(lumen.theme);
  Object.freeze(lumen.storage);
  Object.freeze(lumen.settings);
  Object.freeze(lumen.i18n);
  Object.freeze(lumen.lint);
  Object.freeze(lumen.ai);
  Object.freeze(lumen.assets);
  Object.freeze(lumen.export);
  Object.freeze(lumen.events);
  Object.freeze(lumen.notify);
  Object.freeze(lumen.log);
  Object.freeze(lumen);
  Object.defineProperty(window, 'lumen', { value: lumen, writable: false, configurable: false, enumerable: true });
})();`
}

/** bootstrap 源码的固定片段（单测断言用；不代表全部行为）。 */
export const BOOTSTRAP_MARKERS: readonly string[] = [
  '__LUMEN_BOOT__',
  'window.__LUMEN_BOOT__',
  "addEventListener('message'",
  "'f' + (state.seq++)",
  'REQ_TIMEOUT',
  "'__ready'",
  "'__error'",
  'unhandledrejection',
  'window.lumen',
  'Object.freeze(lumen)',
]

/** 客户端源码自检（单测用；空数组 = 通过）。 */
export function validateBootstrapSource(source: string): string[] {
  const issues: string[] = []
  if (!source.includes('window.__LUMEN_BOOT__')) issues.push('bootstrap must read window.__LUMEN_BOOT__')
  if (!source.includes('parent.postMessage')) issues.push('bootstrap must postMessage to parent')
  if (!source.includes('__ready')) issues.push('bootstrap must send __ready')
  if (!source.includes('bootFailed')) issues.push('bootstrap must not send __ready after a boot failure')
  if (!source.includes('__LUMEN_PLUGIN_EVALUATED__')) issues.push('bootstrap must check the entry-evaluated sentinel')
  if (!source.includes('markBootFailure')) issues.push('bootstrap must report E-RUN-02 on boot failure')
  if (!source.includes('unhandledrejection')) issues.push('bootstrap must capture unhandledrejection')
  for (const name of ['ui', 'commands', 'keymap', 'layout', 'deck', 'theme', 'storage', 'settings', 'i18n', 'lint', 'ai', 'assets', 'export', 'events', 'notify', 'log', 'meta']) {
    if (!source.includes(`lumen.${name} =`)) issues.push(`missing namespace lumen.${name}`)
  }
  return issues
}

/** 帧 boot payload 的类型再导出，方便 host 侧只有 `inject.ts` 一个入口。 */
export type { FrameBootData }
