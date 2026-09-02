import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PlaintextAuthStore } from '../../src/main/whatsapp/plaintext-auth-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PlaintextAuthStore', () => {
  it('round-trips a session across restart with private directory and file permissions', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'whatsapp', 'session.json')
    const first = new PlaintextAuthStore(path)
    const auth = await first.load()
    auth.state.creds.registered = true
    auth.state.creds.platform = 'plaintext-mode-marker'
    await auth.state.keys.set({
      'pre-key': {
        '1': { public: Buffer.from('public'), private: Buffer.from('private') },
      },
    })
    await auth.saveCreds()

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toContain('plaintext-mode-marker')

    const restarted = new PlaintextAuthStore(path)
    expect(await restarted.hasSession()).toBe(true)
    const loaded = await restarted.load()
    const keys = await loaded.state.keys.get('pre-key', ['1'])
    expect(loaded.state.creds.platform).toBe('plaintext-mode-marker')
    expect(Buffer.from(keys['1']!.private).toString()).toBe('private')
  })

  it('clears only the session file', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'whatsapp', 'session.json')
    const store = new PlaintextAuthStore(path)
    const auth = await store.load()
    auth.state.creds.registered = true
    await auth.saveCreds()

    await store.clear()

    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(root)).toBeTruthy()
  })

  it('does not expose its storage path when persistence fails', async () => {
    const root = await temporaryDirectory()
    const parent = join(root, 'blocked')
    const store = new PlaintextAuthStore(join(parent, 'session.json'))
    const auth = await store.load()
    await writeFile(parent, 'not a directory')

    const failure = await auth.saveCreds().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('无法保存本地明文 WhatsApp 登录凭证')
    expect((failure as Error).message).not.toContain(root)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'plaintext-auth-'))
  cleanup.push(directory)
  return directory
}
