import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { ExportPreparer } from '../../src/main/exports/export-preparer.js'
import { createDefaultExportTask } from '../../src/main/exports/export-task-store.js'
import {
  CURRENT_SCHEMA_VERSION,
  type ExportTask,
  type StickerAsset,
  type StickerCollection,
} from '../../src/shared/domain.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ExportPreparer', () => {
  it('does not start an already canceled export preparation', async () => {
    const root = await temporaryDirectory()
    const asset = await fixtureAsset(root, 0, false, 'A.png')
    const controller = new AbortController()
    controller.abort(new DOMException('cancel fixture', 'AbortError'))

    await expect(
      new ExportPreparer().prepare(
        localTask([asset.id], 50),
        collection([asset]),
        root,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses task-local order and local folder grouping without applying WhatsApp pack rules', async () => {
    const root = await temporaryDirectory()
    const assets = await Promise.all([
      fixtureAsset(root, 0, false, '同名.png'),
      fixtureAsset(root, 1, true, '同名.gif'),
      fixtureAsset(root, 2, false, '第三张.png'),
    ])
    const task = localTask(['asset-1', 'asset-0', 'asset-2'], 2)

    const prepared = await new ExportPreparer().prepare(task, collection(assets), root)

    expect(prepared.destination).toBe('local-folder')
    expect(prepared.conversionVersion).toBe('local-original-v1')
    expect(prepared.orderedAssetIds).toEqual(['asset-1', 'asset-0', 'asset-2'])
    expect(prepared.groups).toHaveLength(2)
    expect(prepared.groups[0]).toMatchObject({
      name: '表情备份 1',
      mediaKind: 'mixed',
      assetIds: ['asset-1', 'asset-0'],
      status: 'prepared',
    })
    expect(prepared.groups[1]).toMatchObject({
      name: '表情备份 2',
      mediaKind: 'static',
      assetIds: ['asset-2'],
      status: 'prepared',
    })
    expect(prepared.groups.flatMap((group) => group.payloads).map((item) => item.fileName)).toEqual(
      ['同名.gif', '同名.png', '第三张.png'],
    )
  })

  it('creates a different deterministic fingerprint when order or destination settings change', async () => {
    const root = await temporaryDirectory()
    const assets = await Promise.all([
      fixtureAsset(root, 0, false, 'A.png'),
      fixtureAsset(root, 1, false, 'B.png'),
    ])
    const preparer = new ExportPreparer()
    const first = await preparer.prepare(
      localTask(['asset-0', 'asset-1'], 50),
      collection(assets),
      root,
    )
    const second = await preparer.prepare(
      localTask(['asset-1', 'asset-0'], 50),
      collection(assets),
      root,
    )
    const renamedTask = localTask(['asset-0', 'asset-1'], 50)
    renamedTask.localFolder.batchName = '另一个批次'
    const renamed = await preparer.prepare(renamedTask, collection(assets), root)

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(renamed.fingerprint).not.toBe(first.fingerprint)
  })

  it('prepares WhatsApp groups from the export task instead of collection-global selection', async () => {
    const root = await temporaryDirectory()
    const assets = await Promise.all([
      fixtureAsset(root, 0, false, 'A.png'),
      fixtureAsset(root, 1, false, 'B.png'),
      fixtureAsset(root, 2, false, 'C.png'),
      fixtureAsset(root, 3, false, 'Not selected.png'),
    ])
    const base = createDefaultExportTask(new Date('2026-08-12T00:00:00.000Z'), 'wa')
    const task: ExportTask = {
      ...base,
      destination: { kind: 'whatsapp' },
      selectedAssetIds: ['asset-2', 'asset-0', 'asset-1'],
      orderedAssetIds: ['asset-2', 'asset-0', 'asset-1'],
      whatsapp: { title: '任务名称', publisher: '任务发布者', packSize: 30 },
    }
    const library = collection(assets)
    library.selectedAssetIds = ['asset-3']

    const prepared = await new ExportPreparer().prepare(task, library, root)

    expect(prepared.groups).toHaveLength(1)
    expect(prepared.groups[0]).toMatchObject({
      name: '任务名称',
      mediaKind: 'static',
      assetIds: ['asset-2', 'asset-0', 'asset-1'],
      status: 'prepared',
    })
    expect(prepared.groups[0]!.payloads.filter((payload) => payload.role === 'tray')).toHaveLength(
      1,
    )

    const reimportedAssets = assets.map((asset, index) => ({ ...asset, id: `reimported-${index}` }))
    const sameContentNewTask = await new ExportPreparer().prepare(
      {
        ...task,
        id: 'export-task-another-workflow',
        selectedAssetIds: ['reimported-2', 'reimported-0', 'reimported-1'],
        orderedAssetIds: ['reimported-2', 'reimported-0', 'reimported-1'],
      },
      collection(reimportedAssets),
      root,
    )
    expect(sameContentNewTask.groups[0]!.id).not.toBe(prepared.groups[0]!.id)
    expect(sameContentNewTask.fingerprint).toBe(prepared.fingerprint)
  })

  it('converts local WebP derivatives without modifying the library original', async () => {
    const root = await temporaryDirectory()
    const asset = await fixtureAsset(root, 0, false, 'Original.png')
    const before = await readFile(asset.originalPath)
    const task = localTask([asset.id], 50)
    task.localFolder.format = 'converted-webp'

    const prepared = await new ExportPreparer().prepare(task, collection([asset]), root)
    const payload = prepared.groups[0]!.payloads[0]!

    expect(payload.mimeType).toBe('image/webp')
    expect(payload.sourcePath).not.toBe(asset.originalPath)
    expect((await sharp(payload.sourcePath).metadata()).format).toBe('webp')
    expect(await readFile(asset.originalPath)).toEqual(before)
  })
})

function localTask(assetIds: string[], itemsPerFolder: number): ExportTask {
  const task = createDefaultExportTask(new Date('2026-08-12T00:00:00.000Z'), 'local')
  return {
    ...task,
    destination: {
      kind: 'local-folder',
      directoryId: 'export-directory-12345678-1234-1234-1234-123456789abc',
      directoryLabel: 'Exports',
    },
    selectedAssetIds: [...assetIds],
    orderedAssetIds: [...assetIds],
    localFolder: { ...task.localFolder, batchName: '表情备份', itemsPerFolder },
  }
}

async function fixtureAsset(
  root: string,
  index: number,
  animated: boolean,
  displayName: string,
): Promise<StickerAsset> {
  const originalPath = join(root, `asset-${index}${extname(displayName) || '.png'}`)
  const contents = await sharp({
    create: {
      width: 32 + index,
      height: 24 + index,
      channels: 4,
      background: { r: index * 40, g: 100, b: 180, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
  await writeFile(originalPath, contents)
  return {
    id: `asset-${index}`,
    sources: [
      {
        id: 'source-test',
        kind: 'local',
        label: '本机导入',
        importBatchId: 'batch-test',
        importedAt: '2026-08-12T00:00:00.000Z',
      },
    ],
    displayName,
    originalPath,
    sha256: createHash('sha256').update(contents).digest('hex'),
    mimeType: animated ? 'image/gif' : 'image/png',
    animated,
    width: 32 + index,
    height: 24 + index,
    importedAt: '2026-08-12T00:00:00.000Z',
    sourceOrder: index,
    userOrder: index,
  }
}

function collection(assets: StickerAsset[]): StickerCollection {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'collection-test',
    title: '旧标题',
    publisher: '旧发布者',
    packSize: 30,
    assets,
    selectedAssetIds: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-export-preparer-'))
  cleanup.push(directory)
  await mkdir(directory, { recursive: true })
  return directory
}
