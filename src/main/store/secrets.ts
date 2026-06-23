// Password storage via Electron's safeStorage — encrypted with the OS keystore
// (DPAPI on Windows, Keychain on macOS, libsecret on Linux). No native module to
// build, and plaintext never touches disk.
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const FILE = () => join(app.getPath('userData'), 'secrets.json')

type Blob = Record<string, string> // connectionId -> base64(ciphertext)

function load(): Blob {
  try {
    if (!existsSync(FILE())) return {}
    return JSON.parse(readFileSync(FILE(), 'utf-8'))
  } catch {
    return {}
  }
}

function persist(blob: Blob): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(blob), 'utf-8')
}

export const secrets = {
  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  },

  set(id: string, password: string): boolean {
    if (!password || !safeStorage.isEncryptionAvailable()) return false
    const blob = load()
    blob[id] = safeStorage.encryptString(password).toString('base64')
    persist(blob)
    return true
  },

  get(id: string): string | null {
    if (!safeStorage.isEncryptionAvailable()) return null
    const enc = load()[id]
    if (!enc) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  },

  clear(id: string): void {
    const blob = load()
    if (id in blob) {
      delete blob[id]
      persist(blob)
    }
  }
}
