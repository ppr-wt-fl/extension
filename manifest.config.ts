import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }
import { flags } from './src/flags.ts'

export default defineManifest({
  manifest_version: 3,
  name: pkg.name,
  description: pkg.description,
  version: pkg.version,
  icons: {
    48: 'public/logo.png',
  },
  action: {
    default_icon: {
      48: 'public/logo.png',
    },
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['webRequest', 'offscreen', 'declarativeNetRequest', ...(flags.debugger ? ['debugger' as const] : [])],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      // patches fetch/XHR before the page's scripts run
      js: ['src/content/patch.ts'],
      matches: ['<all_urls>'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
    {
      js: ['src/content/relay.ts'],
      matches: ['<all_urls>'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
  content_security_policy: {
    // instantiating the feature extraction wasm needs wasm-unsafe-eval
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
})
