import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value: Buffer) =>
      Buffer.from(value.toString().replace(/^encrypted:/, ''), 'base64').toString(),
  },
}))

import { CredentialAuthStore } from '../../src/main/whatsapp/credential-auth-store.js'
import { CredentialModeStore } from '../../src/main/whatsapp/credential-mode-store.js'
import { EncryptedAuthStore } from '../../src/main/whatsapp/encrypted-auth-store.js'
import { PlaintextAuthStore } from '../../src/main/whatsapp/plaintext-auth-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CredentialAuthStore', () => {
  it('defaults to Keychain protection and refuses a mode switch while any session exists', async () => {
    const setup = await stores()
    await setup.store.initialize()
    expect(setup.store.getMode()).toBe('keychain')
    const auth = await setup.store.load()
    auth.state.creds.registered = true
    await auth.saveCreds()

    await expect(setup.store.setMode('plaintext')).rejects.toThrow(/先登出/)
    expect(setup.store.getMode()).toBe('keychain')
  })

  it('switches only after logout and restores the selected mode after restart', async () => {
    const setup = await stores()
    const auth = await setup.store.load()
    auth.state.creds.registered = true
    await auth.saveCreds()
    await setup.store.clear()
    await setup.store.setMode('plaintext')

    expect((await stat(dirname(setup.modePath))).mode & 0o777).toBe(0o700)
    expect((await stat(setup.modePath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(setup.modePath, 'utf8')).mode).toBe('plaintext')

    const restarted = new CredentialAuthStore(
      new CredentialModeStore(setup.modePath),
      new EncryptedAuthStore(setup.encryptedPath),
      new PlaintextAuthStore(setup.plaintextPath),
    )
    await restarted.initialize()
    expect(restarted.getMode()).toBe('plaintext')
  })

  it('logout clears both possible session files without touching library or snapshots', async () => {
    const setup = await stores()
    const librarySentinel = join(setup.root, 'library', 'manifest.json')
    const snapshotSentinel = join(setup.root, 'exports', 'snapshots', 'saved', 'manifest.json')
    await mkdir(dirname(librarySentinel), { recursive: true })
    await mkdir(dirname(snapshotSentinel), { recursive: true })
    await Promise.all([
      writeFile(librarySentinel, 'library'),
      writeFile(snapshotSentinel, 'snapshot'),
    ])
    const keychain = await setup.keychainStore.load()
    keychain.state.creds.registered = true
    await keychain.saveCreds()
    const plaintext = await setup.plaintextStore.load()
    plaintext.state.creds.registered = true
    await plaintext.saveCreds()

    await setup.store.clear()

    await expect(readFile(setup.encryptedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(setup.plaintextPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(librarySentinel, 'utf8')).toBe('library')
    expect(await readFile(snapshotSentinel, 'utf8')).toBe('snapshot')
  })
})

async function stores() {
  const root = await mkdtemp(join(tmpdir(), 'credential-auth-'))
  cleanup.push(root)
  const modePath = join(root, 'whatsapp', 'credential-mode.json')
  const encryptedPath = join(root, 'whatsapp', 'session.enc')
  const plaintextPath = join(root, 'whatsapp', 'session.json')
  const keychainStore = new EncryptedAuthStore(encryptedPath)
  const plaintextStore = new PlaintextAuthStore(plaintextPath)
  return {
    root,
    modePath,
    encryptedPath,
    plaintextPath,
    keychainStore,
    plaintextStore,
    store: new CredentialAuthStore(
      new CredentialModeStore(modePath),
      keychainStore,
      plaintextStore,
    ),
  }
}
