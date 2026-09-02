import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) =>
      Buffer.from(value.toString().replace(/^encrypted:/, ''), 'base64').toString(),
  },
}))

import { EncryptedAuthStore } from '../../src/main/whatsapp/encrypted-auth-store.js'

describe('EncryptedAuthStore', () => {
  let temporaryDirectory: string
  let authPath: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'encrypted-auth-'))
    authPath = join(temporaryDirectory, 'whatsapp', 'session.enc')
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('round-trips credentials and signal keys without writing plaintext JSON', async () => {
    const firstStore = new EncryptedAuthStore(authPath)
    const first = await firstStore.load()
    first.state.creds.registered = true
    first.state.creds.platform = 'secret-platform-marker'
    await first.state.keys.set({
      'pre-key': {
        '1': { public: Buffer.from('public'), private: Buffer.from('private') },
      },
    })
    await first.saveCreds()

    const diskContents = await readFile(authPath)
    expect(diskContents.toString()).toMatch(/^encrypted:/)
    expect(diskContents.toString()).not.toContain('secret-platform-marker')
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)

    const secondStore = new EncryptedAuthStore(authPath)
    expect(await secondStore.hasSession()).toBe(true)
    const second = await secondStore.load()
    const keys = await second.state.keys.get('pre-key', ['1'])
    expect(second.state.creds.platform).toBe('secret-platform-marker')
    expect(Buffer.from(keys['1']!.public).toString()).toBe('public')
    expect(Buffer.from(keys['1']!.private).toString()).toBe('private')
  })

  it('clears the encrypted session without affecting its parent data directory', async () => {
    const store = new EncryptedAuthStore(authPath)
    const auth = await store.load()
    auth.state.creds.registered = true
    await auth.saveCreds()
    await store.clear()

    await expect(readFile(authPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(temporaryDirectory)).toBeTruthy()
  })

  it('recognizes a QR-linked session even when Baileys leaves registered false', async () => {
    const firstStore = new EncryptedAuthStore(authPath)
    const first = await firstStore.load()
    first.state.creds.registered = false
    first.state.creds.me = { id: '85212345678:1@s.whatsapp.net', name: 'Test' }
    first.state.creds.account = {} as NonNullable<typeof first.state.creds.account>
    await first.saveCreds()

    expect(await new EncryptedAuthStore(authPath).hasSession()).toBe(true)
  })
})
