import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // Emit every asset as a file. Small font subsets would otherwise be inlined
      // as `data:` URIs, and the app's CSP sets no font-src — so they fall back to
      // `default-src 'self'`, which refuses them and silently drops those glyph
      // ranges to a system font.
      assetsInlineLimit: 0,
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
