// Builds the relay (src/relay/relay.ts) into one self-contained ESM file,
// resources/relay.mjs. The app uploads that file to the remote host, which has
// Node but none of this repo's node_modules — so the Agent SDK is bundled in and
// only Node's own modules stay external.
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    ssr: resolve('src/relay/relay.ts'),
    outDir: 'resources',
    // resources/ also holds the app icon.
    emptyOutDir: false,
    target: 'node18',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'relay.mjs' } }
  },
  ssr: { noExternal: true }
})
