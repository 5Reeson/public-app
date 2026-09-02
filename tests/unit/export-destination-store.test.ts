import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ExportDestinationStore } from '../../src/main/exports/export-destination-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ExportDestinationStore', () => {
  it('keeps real paths in a private Main-only store and returns only an opaque reference', async () => {
    const root = await temporaryDirectory()
    const selected = join(root, '用户导出位置')
    const storePath = join(root, 'user-data', 'exports', 'destinations.json')
    await mkdir(selected)
    const store = new ExportDestinationStore({
      path: storePath,
      createId: () => '12345678-1234-1234-1234-123456789abc',
      now: () => new Date('2026-08-12T01:00:00.000Z'),
    })

    const choice = await store.rememberDirectory(selected)
    if (choice.kind !== 'local-folder') throw new Error('Expected a local-folder destination')

    expect(choice).toEqual({
      kind: 'local-folder',
      directoryId: 'export-directory-12345678-1234-1234-1234-123456789abc',
      directoryLabel: '用户导出位置',
    })
    expect(JSON.stringify(choice)).not.toContain(root)
    expect(await store.getDirectoryPath(choice.directoryId!)).toBe(await realpath(selected))
    expect(await store.resolveDirectory(choice.directoryId!)).toBe(await realpath(selected))
    expect(
      await new ExportDestinationStore({ path: storePath }).getChoice(choice.directoryId!),
    ).toEqual(choice)
    expect((await stat(dirname(storePath))).mode & 0o777).toBe(0o700)
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(storePath, 'utf8')).toContain(await realpath(selected))
  })

  it('reuses the same opaque reference when a folder is selected again', async () => {
    const root = await temporaryDirectory()
    const selected = join(root, 'exports')
    await mkdir(selected)
    let nextId = 0
    const store = new ExportDestinationStore({
      path: join(root, 'destinations.json'),
      createId: () => `${String(++nextId).padStart(8, '0')}-1234-1234-1234-123456789abc`,
    })

    expect(await store.rememberDirectory(selected)).toEqual(await store.rememberDirectory(selected))
    expect(nextId).toBe(1)
  })

  it('recovers a valid private destination file from backup without overwriting future schemas', async () => {
    const root = await temporaryDirectory()
    const firstDirectory = join(root, 'first')
    const secondDirectory = join(root, 'second')
    const storePath = join(root, 'destinations.json')
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    const store = new ExportDestinationStore({ path: storePath, createId: () => ids.shift()! })
    const first = await store.rememberDirectory(firstDirectory)
    if (first.kind !== 'local-folder') throw new Error('Expected a local-folder destination')
    await store.rememberDirectory(secondDirectory)
    await writeFile(storePath, '{broken', 'utf8')

    expect(
      await new ExportDestinationStore({ path: storePath }).getChoice(first.directoryId!),
    ).toEqual(first)

    const futurePath = join(root, 'future-destinations.json')
    const future = { schemaVersion: 99, directories: [] }
    await writeFile(futurePath, JSON.stringify(future), 'utf8')
    await expect(
      new ExportDestinationStore({ path: futurePath }).getChoice('missing'),
    ).rejects.toThrow(/Unsupported/)
    expect(JSON.parse(await readFile(futurePath, 'utf8'))).toEqual(future)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-export-destination-'))
  cleanup.push(directory)
  return directory
}
