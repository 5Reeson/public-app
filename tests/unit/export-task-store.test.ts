import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ExportTaskStore,
  UnsupportedExportTaskSchemaError,
} from '../../src/main/exports/export-task-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ExportTaskStore', () => {
  it('persists workflow selection and task-local order across reloads', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'exports', 'current-task.json')
    const times = [
      new Date('2026-08-11T01:00:00.000Z'),
      new Date('2026-08-11T02:00:00.000Z'),
      new Date('2026-08-11T03:00:00.000Z'),
    ]
    const store = new ExportTaskStore({
      path,
      now: () => times.shift()!,
      createId: () => 'fixture-id',
    })
    const initial = await store.loadOrCreate()
    const saved = await store.saveDraft({
      currentStep: 3,
      source: { kind: 'library', label: '我的表情库' },
      destination: { kind: 'whatsapp' },
      selectedAssetIds: ['asset-a', 'asset-b'],
      orderedAssetIds: ['asset-b', 'asset-a'],
      whatsapp: { ...initial.whatsapp, title: '旅行表情', packSize: 13 },
      localFolder: initial.localFolder,
    })

    const prepared = await store.setPrepared({
      fingerprint: 'restart-safe-fingerprint',
      status: 'prepared',
      preparedAt: '2026-08-11T02:30:00.000Z',
    })
    expect(await new ExportTaskStore({ path }).load()).toEqual(prepared)
    expect(saved.id).toBe('export-task-fixture-id')
    expect(saved.createdAt).toBe(initial.createdAt)
    expect(saved.updatedAt).toBe('2026-08-11T02:00:00.000Z')
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('recovers the previous valid task from its backup', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const store = new ExportTaskStore({ path, createId: () => 'fixture' })
    const initial = await store.loadOrCreate()
    const first = await store.save({ ...initial, currentStep: 2 })
    await store.save({ ...first, currentStep: 3 })
    await writeFile(path, '{broken', 'utf8')

    expect((await new ExportTaskStore({ path }).load()).currentStep).toBe(2)
  })

  it('migrates a stage-1 schema v1 task without losing workflow state', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const v1 = {
      schemaVersion: 1,
      id: 'export-task-existing',
      currentStep: 3,
      source: { kind: 'library', label: '我的表情库' },
      destination: { kind: 'whatsapp' },
      selectedAssetIds: ['asset-a'],
      orderedAssetIds: ['asset-a'],
      whatsapp: { title: '已有任务', publisher: 'Tests', packSize: 13 },
      localFolder: { format: 'original', naming: 'original', itemsPerFolder: 50 },
      createdAt: '2026-08-11T01:00:00.000Z',
      updatedAt: '2026-08-11T02:00:00.000Z',
    }
    await writeFile(path, JSON.stringify(v1), 'utf8')

    const migrated = await new ExportTaskStore({ path }).loadOrCreate()

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      id: v1.id,
      currentStep: 3,
      selectedAssetIds: ['asset-a'],
      localFolder: { batchName: '本地导出' },
    })
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toEqual(v1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(migrated)
  })

  it('invalidates prepared state when destination, content order, or settings change', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const store = new ExportTaskStore({ path, createId: () => 'invalidation' })
    const initial = await store.loadOrCreate()
    const configured = await store.saveDraft({
      currentStep: 3,
      source: { kind: 'library', label: '我的表情库' },
      destination: { kind: 'whatsapp' },
      selectedAssetIds: ['asset-a', 'asset-b'],
      orderedAssetIds: ['asset-a', 'asset-b'],
      whatsapp: initial.whatsapp,
      localFolder: initial.localFolder,
    })
    const prepared = await store.setPrepared({
      fingerprint: 'prepared-fingerprint',
      status: 'prepared',
      preparedAt: '2026-08-11T03:00:00.000Z',
    })

    const navigationOnly = await store.saveDraft({
      ...pickDraft(prepared),
      currentStep: 4,
    })
    expect(navigationOnly.prepared).toEqual(prepared.prepared)

    const reordered = await store.saveDraft({
      ...pickDraft(navigationOnly),
      orderedAssetIds: ['asset-b', 'asset-a'],
    })
    expect(reordered.prepared).toBeUndefined()
    expect(reordered.id).toBe(configured.id)
  })

  it('prunes deleted library assets from the task without changing library order', async () => {
    const root = await temporaryDirectory()
    const store = new ExportTaskStore({
      path: join(root, 'current-task.json'),
      createId: () => 'reconcile',
    })
    const initial = await store.loadOrCreate()
    await store.saveDraft({
      currentStep: 3,
      source: { kind: 'library', label: '我的表情库' },
      destination: { kind: 'local-folder' },
      selectedAssetIds: ['asset-a', 'asset-b'],
      orderedAssetIds: ['asset-b', 'asset-a'],
      whatsapp: initial.whatsapp,
      localFolder: initial.localFolder,
    })
    await store.setPrepared({ fingerprint: 'before-delete', status: 'prepared' })

    const reconciled = await store.reconcileAssets(new Set(['asset-b']))

    expect(reconciled.selectedAssetIds).toEqual(['asset-b'])
    expect(reconciled.orderedAssetIds).toEqual(['asset-b'])
    expect(reconciled.prepared).toBeUndefined()
  })

  it('starts a new workflow identity and clears only current mutable state', async () => {
    const root = await temporaryDirectory()
    const ids = ['first', 'second']
    const store = new ExportTaskStore({
      path: join(root, 'current-task.json'),
      createId: () => ids.shift()!,
    })
    const initial = await store.loadOrCreate()
    await store.setPrepared({
      fingerprint: 'saved-result',
      status: 'complete',
      snapshotId: 'snapshot-independent',
    })

    const replacement = await store.reset()

    expect(replacement).toMatchObject({
      id: 'export-task-second',
      currentStep: 1,
      selectedAssetIds: [],
      orderedAssetIds: [],
    })
    expect(replacement.prepared).toBeUndefined()
    expect(replacement.id).not.toBe(initial.id)
    expect((await new ExportTaskStore({ path: store.path }).load()).id).toBe(replacement.id)
  })

  it('rejects future schemas and invalid task-local ordering without replacing the file', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const future = { schemaVersion: 99, id: 'future' }
    await writeFile(path, JSON.stringify(future), 'utf8')
    await expect(new ExportTaskStore({ path }).loadOrCreate()).rejects.toBeInstanceOf(
      UnsupportedExportTaskSchemaError,
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(future)

    const validPath = join(root, 'valid-task.json')
    const validStore = new ExportTaskStore({ path: validPath, createId: () => 'valid' })
    const valid = await validStore.loadOrCreate()
    await expect(
      validStore.save({
        ...valid,
        selectedAssetIds: ['asset-a'],
        orderedAssetIds: ['asset-b'],
      }),
    ).rejects.toThrow(/order must contain every selected asset exactly once/)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-export-task-'))
  cleanup.push(directory)
  return directory
}

function pickDraft(task: Awaited<ReturnType<ExportTaskStore['load']>>) {
  return {
    currentStep: task.currentStep,
    source: task.source,
    destination: task.destination,
    selectedAssetIds: task.selectedAssetIds,
    orderedAssetIds: task.orderedAssetIds,
    whatsapp: task.whatsapp,
    localFolder: task.localFolder,
  }
}
