import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TemporaryWechatAppCopy } from '../../src/main/sources/wechat4/temporary-app-copy.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fakeWechatApp(parent: string): Promise<string> {
  const appPath = join(parent, 'FixtureWeChat.app')
  const executableDirectory = join(appPath, 'Contents', 'MacOS')
  const resources = join(appPath, 'Contents', 'Resources')
  await Promise.all([
    mkdir(executableDirectory, { recursive: true }),
    mkdir(resources, { recursive: true }),
  ])
  const executable = join(executableDirectory, 'WeChat')
  await Promise.all([
    writeFile(join(appPath, 'Contents', 'Info.plist'), '<plist>synthetic</plist>'),
    writeFile(executable, '#!/bin/sh\nexit 0\n'),
    writeFile(join(resources, 'resource.txt'), 'synthetic resource'),
  ])
  await chmod(executable, 0o755)
  await symlink('resource.txt', join(resources, 'resource-link'))
  return appPath
}

describe('TemporaryWechatAppCopy', () => {
  it('copies a synthetic app into a private session and removes the whole session idempotently', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'temporary-app-copy-test-'))
    cleanup.push(parent)
    const source = await fakeWechatApp(parent)

    const copy = await TemporaryWechatAppCopy.create({
      sourceAppPath: source,
      temporaryParent: parent,
    })

    expect((await stat(copy.sessionRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(join(copy.appPath, 'Contents', 'MacOS', 'WeChat'))).isFile()).toBe(true)
    expect(
      (await lstat(join(copy.appPath, 'Contents', 'Resources', 'resource-link'))).isSymbolicLink(),
    ).toBe(true)
    expect(await readdir(copy.sessionRoot)).toEqual(['WeChat.app'])

    await copy.cleanup()
    await copy.cleanup()
    await expect(stat(copy.sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not leave a session directory when source validation fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'temporary-app-copy-failure-'))
    cleanup.push(parent)
    const invalid = join(parent, 'Invalid.app')
    await mkdir(invalid)

    await expect(
      TemporaryWechatAppCopy.create({ sourceAppPath: invalid, temporaryParent: parent }),
    ).rejects.toThrow(/Info\.plist|ENOENT/)
    expect(
      (await readdir(parent)).filter((name) => name.startsWith('cn-memes-wechat4-app-')),
    ).toEqual([])
  })
})
