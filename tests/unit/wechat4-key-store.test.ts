import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { clearCandidateDatabaseKey } from '../../src/main/sources/wechat4/candidate-key-pipe.js'
import { Wechat4KeyStore } from '../../src/main/sources/wechat4/wechat4-key-store.js'

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

describe('Wechat4KeyStore', () => {
  it('persists candidate bytes only through the Keychain-backed encryption boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-key-store-test-'))
    cleanup.push(parent)
    const directory = join(parent, 'keys')
    const store = new Wechat4KeyStore(directory, testEncryption)
    const accountId = 'wechat4-0123456789abcdef'
    const candidate = {
      role: 'emoticon' as const,
      salt: Buffer.alloc(16, 0x12),
      key: Buffer.alloc(32, 0x34),
    }

    await store.save(accountId, candidate)
    const storedPath = join(directory, `${accountId}.keychain`)
    const encrypted = await readFile(storedPath)
    expect(encrypted.toString('utf8')).not.toContain(candidate.key.toString('hex'))
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(storedPath)).mode & 0o777).toBe(0o600)

    const loaded = await store.load(accountId)
    expect(loaded?.salt.equals(candidate.salt)).toBe(true)
    expect(loaded?.key.equals(candidate.key)).toBe(true)
    if (loaded) clearCandidateDatabaseKey(loaded)
    await store.clear(accountId)
    await expect(store.load(accountId)).resolves.toBeUndefined()

    encrypted.fill(0)
    clearCandidateDatabaseKey(candidate)
  })

  it('keeps multiple account candidates isolated and clears only the selected account', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-key-store-isolation-'))
    cleanup.push(parent)
    const store = new Wechat4KeyStore(join(parent, 'keys'), testEncryption)
    const firstId = 'wechat4-0123456789abcdef'
    const secondId = 'wechat4-fedcba9876543210'
    const first = {
      role: 'emoticon' as const,
      salt: Buffer.alloc(16, 0x11),
      key: Buffer.alloc(32, 0x21),
    }
    const second = {
      role: 'emoticon' as const,
      salt: Buffer.alloc(16, 0x12),
      key: Buffer.alloc(32, 0x22),
    }

    await store.save(firstId, first)
    await store.save(secondId, second)
    await store.clear(firstId)

    await expect(store.load(firstId)).resolves.toBeUndefined()
    const loadedSecond = await store.load(secondId)
    expect(loadedSecond?.salt.equals(second.salt)).toBe(true)
    expect(loadedSecond?.key.equals(second.key)).toBe(true)

    if (loadedSecond) clearCandidateDatabaseKey(loadedSecond)
    clearCandidateDatabaseKey(first)
    clearCandidateDatabaseKey(second)
  })
})
