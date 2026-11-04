/**
 * pluginspage namespace · English. Mirrors pluginspage.zh.ts key-for-key.
 * Consumer: samples domain `src/pages/plugins/**` (plugins.html).
 */
export const pluginspageEn = {
  title: 'LUMEN Plugins · 0.4.0',
  tagline: 'Plugins reshape the workbench; your decks stay yours',
  subtitle: 'Local plugin packages and three built-in samples',
  back: 'Back to workbench',
  version: 'Version {version}',
  noMarket:
    '0.4.0 has no plugin marketplace and no cloud downloads. These are the three samples that ship with the app; other plugins come from local files — judge the source before you install.',

  samples: {
    title: 'Built-in samples',
    body: 'Three samples ship with the app and stay off by default. Disable or uninstall them at any time.',
    defaultOff: 'Off by default',
    defaultOffHint: 'Enable it on the Plugins page after install',
    permissionsCount: '{count} permissions',
    permissions: 'Capability summary',
    version: 'Version {version}',
    size: 'About {size}',
    download: 'Download',
    downloadDone: 'Downloaded — drag the file into the workbench to install',
    install: 'Install',
    installDone: 'Install started — confirm permissions back in the workbench',
    cardAria: '{name} sample card',
  },

  sample: {
    brandguard: {
      name: 'BrandGuard',
      desc: 'Brand colors, logos, and pre-export checks in one theme plus rules.',
    },
    chartkit: {
      name: 'ChartKit',
      desc: 'Turn CSV into theme-aware charts and insert them into the current slide.',
    },
    focusdesk: {
      name: 'FocusDesk',
      desc: 'A writing board, a Zen overlay, and layout presets that keep one screen focused.',
    },
  },

  permissions: {
    title: 'Permission summary',
    body: 'You confirm each permission at install. Normal permissions are on; sensitive ones are off by default.',
    sensitive: 'Sensitive permission',
    cannotTitle: 'What it cannot do',
    cannot1: 'Go online',
    cannot2: 'Read your files',
    cannot3: "Read other plugins' data",
    cannot4: 'Change the data structure',
    revoke: 'You can revoke permissions at any time after install',
  },

  install: {
    title: 'How to install',
    file: 'Drag a .lumenplug file into the workbench window, or choose a file on the Plugins page.',
    url: 'The workbench can install from a link, but it asks you to confirm the source first.',
    sample: 'Use Install or Download on a sample card above.',
    step1: 'Download or pick a plugin package',
    step2: 'Drag it into the workbench, or click Install',
    step3: 'Confirm permissions and start using it',
    open: 'Open the workbench',
    dragHint: 'Drop it anywhere in the window',
  },

  docs: {
    title: 'Plugin developer docs',
    body: 'Single-file ESM, no build step, no dependencies. Manifest, permissions, and the 9 slots are fixed contracts.',
    manifest: 'Manifest fields',
    capabilities: '15 permissions',
    slots: '9 slots',
    sdk: 'UI primitives',
    abi: 'Interface version 1.0',
    samples: 'Sample walkthroughs',
    open: 'Read the developer docs',
  },

  author: {
    title: 'Author and license',
    body: 'LUMEN · Apache-2.0 + Commons Clause',
    source: 'Source location',
    issues: 'Report an issue',
  },

  safety: {
    title: 'Safety notes',
    body: 'Plugins come from third-party authors — judge the risk yourself. Every plugin runs with limited reach and can only do what you allow.',
    safeMode: 'Safe mode turns every plugin off at once.',
    data: 'Plugin data stays in this browser and is never uploaded.',
    diagnostics: 'The diagnostics JSON only holds plugin states and error counts, never deck content.',
    reset: 'Reset workbench clears every plugin and its data in one step.',
  },

  creator: {
    title: 'Customize with one line',
    body: 'Describe the layout or panel you want; Creator proposes a change, and you can keep a satisfying trial as a local plugin.',
    open: 'Open Creator',
    noModel: 'No model? Start from a template',
  },

  faq: {
    title: 'FAQ',
    q1: 'Do plugins upload my deck content?',
    a1: 'No. Plugins cannot go online and only read data you allow.',
    q2: 'Do I lose data when I uninstall a plugin?',
    a2: 'Uninstall removes plugin data by default; you can tick Keep data when uninstalling.',
    q3: 'Why did nothing change after install?',
    a3: 'The three built-in samples stay off by default — enable them on the Plugins page.',
    q4: 'Can older versions open decks that use plugin recipes?',
    a4: 'They need 0.4.0 or later.',
  },

  footer: {
    note: 'Runs locally and offline, no telemetry',
    license: 'Apache-2.0 + Commons Clause',
  },

  a11y: {
    nav: 'Plugin page navigation',
    samples: 'Three built-in samples',
    install: 'How to install',
    docs: 'Developer docs',
    faq: 'FAQ',
    creator: 'Open Creator',
  },
}
