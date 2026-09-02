import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ImportPreferencesStore } from '../../src/main/library/import-preferences.js'

describe('ImportPreferencesStore', () => {
  let temporaryDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'import-preferences-'))
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('persists an existing absolute directory', async () => {
    const selectedDirectory = join(temporaryDirectory, 'stickers')
    const filePath = join(temporaryDirectory, 'settings', 'import-preferences.json')
    await mkdir(selectedDirectory)

    const store = new ImportPreferencesStore(filePath)
    await store.setLastImportDirectory(selectedDirectory)

    expect(await store.getLastImportDirectory()).toBe(selectedDirectory)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      lastImportDirectory: selectedDirectory,
    })
  })

  it('ignores missing and invalid cached directories', async () => {
    const store = new ImportPreferencesStore(
      join(temporaryDirectory, 'settings', 'import-preferences.json'),
    )
    expect(await store.getLastImportDirectory()).toBeUndefined()

    await store.setLastImportDirectory(join(temporaryDirectory, 'missing'))
    expect(await store.getLastImportDirectory()).toBeUndefined()
  })
})
