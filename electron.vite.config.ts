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
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
