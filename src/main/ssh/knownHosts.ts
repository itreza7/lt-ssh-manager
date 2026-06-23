// Real host-key verification: pin keys trust-on-first-use and flag any later
// change loudly (MITM protection).
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const FILE = () => join(app.getPath('userData'), 'known_hosts.json')

interface Entry {
  keyType: string
  fingerprint: string // SHA256:base64
  key: string // base64 of the raw host key (wire format)
}

type Store = Record<string, Entry> // "host:port" -> entry

function load(): Store {
  try {
    if (!existsSync(FILE())) return {}
    return JSON.parse(readFileSync(FILE(), 'utf-8'))
  } catch {
    return {}
  }
}

function persist(store: Store): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(FILE(), JSON.stringify(store, null, 2), 'utf-8')
}

/** OpenSSH-style SHA256 fingerprint (base64, no padding). */
export function fingerprint(key: Buffer): string {
  const b64 = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${b64}`
}

/** Algorithm name is the first length-prefixed field of the SSH key blob. */
export function keyType(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0)
    return key.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

export type VerifyResult =
  | { status: 'known' }
  | { status: 'unknown'; fingerprint: string; keyType: string }
  | { status: 'changed'; fingerprint: string; keyType: string }

export const knownHosts = {
  verify(host: string, port: number, key: Buffer): VerifyResult {
    const id = `${host}:${port}`
    const fp = fingerprint(key)
    const existing = load()[id]
    if (!existing) return { status: 'unknown', fingerprint: fp, keyType: keyType(key) }
    if (existing.fingerprint !== fp) {
      return { status: 'changed', fingerprint: fp, keyType: keyType(key) }
    }
    return { status: 'known' }
  },

  trust(host: string, port: number, key: Buffer): void {
    const store = load()
    store[`${host}:${port}`] = {
      keyType: keyType(key),
      fingerprint: fingerprint(key),
      key: key.toString('base64')
    }
    persist(store)
  }
}
