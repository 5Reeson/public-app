import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Wechat4StoreKeyStore } from '../../src/main/sources/wechat4/wechat4-store-key-store.js'

const cleanup: string[] = []

const testEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext: string) => {
    const bytes = Buffer.from(plaintext)
    for (const index of bytes.keys()) bytes[index] = bytes[index]! ^ 0xa5
    return bytes
  },
  decryptString: (encrypted: Buffer) => {
    const bytes = Buffer.from(encrypted)
    for (const index of bytes.keys()) bytes[index] = bytes[index]! ^ 0xa5
    try {
      return bytes.toString('utf8')
    } finally {
      bytes.fill(0)
    }
  },
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Wechat4StoreKeyStore', () => {
  it('isolates 16-byte official-container keys behind the Keychain encryption boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-store-key-test-'))
    cleanup.push(parent)
    const directory = join(parent, 'keys')
    const store = new Wechat4StoreKeyStore(directory, testEncryption)
    const accountId = 'wechat4-0123456789abcdef'
    const key = Buffer.alloc(16, 0x42)

    await store.save(accountId, key)
    const storedPath = join(directory, `${accountId}.store-keychain`)
    const encrypted = await readFile(storedPath)
    expect(encrypted.toString('utf8')).not.toContain(key.toString('hex'))
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(storedPath)).mode & 0o777).toBe(0o600)

    const loaded = await store.load(accountId)
    expect(loaded?.equals(key)).toBe(true)
    loaded?.fill(0)
    await store.clear(accountId)
    await expect(store.load(accountId)).resolves.toBeUndefined()

    encrypted.fill(0)
    key.fill(0)
  })
})
