import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ExportPreferencesStore } from '../../src/main/exports/export-preferences.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ExportPreferencesStore', () => {
  it('persists a default directory independently from an export task destination', async () => {
    const root = await temporaryDirectory()
    const selected = join(root, '默认导出位置')
    const preferencesPath = join(root, 'settings', 'export-preferences.json')
    await mkdir(selected)
    const store = new ExportPreferencesStore(preferencesPath)
    const resolvedSelected = await realpath(selected)

    expect(await store.getDefaultDirectory()).toBeUndefined()
    expect(await store.setDefaultDirectory(selected)).toBe(resolvedSelected)
    expect(await new ExportPreferencesStore(preferencesPath).getDefaultDirectory()).toBe(
      resolvedSelected,
    )
    expect(JSON.parse(await readFile(preferencesPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      defaultDirectory: resolvedSelected,
    })
    expect((await stat(dirname(preferencesPath))).mode & 0o777).toBe(0o700)
    expect((await stat(preferencesPath)).mode & 0o777).toBe(0o600)
  })

  it('ignores a default directory after it becomes unavailable', async () => {
    const root = await temporaryDirectory()
    const selected = join(root, 'exports')
    const preferencesPath = join(root, 'export-preferences.json')
    await mkdir(selected)
    const store = new ExportPreferencesStore(preferencesPath)
    await store.setDefaultDirectory(selected)
    await rm(selected, { recursive: true })

    expect(await store.getDefaultDirectory()).toBeUndefined()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-export-preferences-'))
  cleanup.push(directory)
  return directory
}
