/**
 * pluginspage 命名空间 · 中文（类型源）。
 * 契约：plan/v0.4.0/02 §8.1（目标 55 键）· 05 §7（plugins.html 六段结构与固定文案）
 *       · 07 §1/§9（无市场声明、三样例默认不启用、诊断导出显眼）。
 * 消费方：samples 域的 `src/pages/plugins/**`（plugins.html）。
 * 文案规则（06 §6.3）：不出现「沙箱 / RPC / 令牌 / iframe」等实现词。
 */
export const pluginspageZh = {
  title: 'LUMEN 插件 · 0.4.0',
  tagline: '插件改造工作台，你的演示仍是你的',
  subtitle: '本地插件包与三款内置样例',
  back: '回到工作台',
  version: '版本 {version}',
  noMarket:
    '0.4.0 没有插件市场，也没有云端下载。这里是随应用发布的三款样例；其他插件来自本地文件，安装前请自行判断。',

  samples: {
    title: '内置样例',
    body: '三款样例随应用发布，默认不启用；安装后可随时停用或卸载。',
    defaultOff: '默认不启用',
    defaultOffHint: '安装后需在插件页手动启用',
    permissionsCount: '{count} 项能力',
    permissions: '能力摘要',
    version: '版本 {version}',
    size: '约 {size}',
    download: '下载',
    downloadDone: '已下载，把文件拖进工作台即可安装',
    install: '安装',
    installDone: '已开始安装，请回到工作台确认权限',
    cardAria: '{name} 样例卡',
  },

  sample: {
    brandguard: {
      name: '品牌守护',
      desc: '把品牌色、logo 与导出前的规范检查收进一套主题和规则。',
    },
    chartkit: {
      name: '数据画报',
      desc: '把 CSV 变成随主题变色的图表，可直接插入当前幕。',
    },
    focusdesk: {
      name: '专注台',
      desc: '写作看板、Zen 浮层与布局预设，让一屏只留该看的东西。',
    },
  },

  permissions: {
    title: '权限摘要',
    body: '安装时逐项确认。非敏感权限默认开启，敏感权限默认关闭。',
    sensitive: '敏感权限',
    cannotTitle: '它不能做什么',
    cannot1: '联网',
    cannot2: '读取你的文件',
    cannot3: '读取其他插件的数据',
    cannot4: '修改数据结构',
    revoke: '安装后可随时撤销权限',
  },

  install: {
    title: '安装方法',
    file: '把 .lumenplug 文件拖进工作台窗口，或在插件页选择文件。',
    url: '工作台支持从链接安装，但会先请你确认来源。',
    sample: '直接点上方样例卡的「安装」或「下载」。',
    step1: '下载或选择插件包',
    step2: '拖进工作台，或点「安装」',
    step3: '确认权限，开始使用',
    open: '打开工作台',
    dragHint: '拖到窗口任意位置即可',
  },

  docs: {
    title: '插件开发文档',
    body: '单文件 ESM、无构建、无依赖。清单、权限与 9 个插槽都有固定契约。',
    manifest: '清单字段',
    capabilities: '15 项权限',
    slots: '9 个插槽',
    sdk: '界面基元',
    abi: '接口版本 1.0',
    samples: '样例拆解',
    open: '阅读开发文档',
  },

  author: {
    title: '作者与许可',
    body: 'LUMEN 幕光 · Apache-2.0 + Commons Clause',
    source: '源码位置',
    issues: '问题反馈',
  },

  safety: {
    title: '安全说明',
    body: '插件由第三方作者提供，请自行判断风险。所有插件都在受限环境里运行，只能做你授权的操作。',
    safeMode: '安全模式可以一次性停用所有插件。',
    data: '插件数据保存在本机浏览器里，不上传。',
    diagnostics: '导出诊断 JSON 只含插件状态与错误计数，不含演示内容。',
    reset: '恢复默认工作台可一次清空所有插件与插件数据。',
  },

  creator: {
    title: '用一句话改工作台',
    body: '描述想要的布局或面板，创造模式给出提案，试跑满意后保留为本地插件。',
    open: '打开创造模式',
    noModel: '没有模型也能从模板开始',
  },

  faq: {
    title: '常见问题',
    q1: '插件会上传我的演示内容吗？',
    a1: '不会。插件没有联网能力，只能读取你授权的数据。',
    q2: '卸载插件会丢数据吗？',
    a2: '卸载默认删除插件数据；卸载时可以勾选保留数据。',
    q3: '为什么安装后没有变化？',
    a3: '三款内置样例默认不启用，请到插件页手动启用。',
    q4: '旧版本能打开带插件配方的演示吗？',
    a4: '需要 0.4.0 及以上版本打开。',
  },

  footer: {
    note: '本地离线运行，无遥测',
    license: 'Apache-2.0 + Commons Clause',
  },

  a11y: {
    nav: '插件页导航',
    samples: '三款内置样例',
    install: '安装方法',
    docs: '开发文档',
    faq: '常见问题',
    creator: '打开创造模式',
  },
}
