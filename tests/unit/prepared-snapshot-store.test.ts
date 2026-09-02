import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PreparedExportResult } from '../../src/main/exports/export-preparer.js'
import {
  PreparedSnapshotStore,
  toPreparedSnapshotView,
} from '../../src/main/exports/prepared-snapshot-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('PreparedSnapshotStore', () => {
  it('copies payloads into an immutable private snapshot that survives source deletion', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'library-original.png')
    const contents = Buffer.from('synthetic sticker payload')
    await writeFile(sourcePath, contents)
    const prepared = preparation(sourcePath, contents, fingerprint('first'))
    const store = new PreparedSnapshotStore({
      rootDirectory: join(root, 'snapshots'),
      createId: () => '12345678-1234-1234-1234-123456789abc',
      now: () => new Date('2026-08-12T02:00:00.000Z'),
    })

    const result = await store.save(prepared)
    expect(result.kind).toBe('saved')
    const manifest = result.manifest
    const payload = manifest.groups[0]!.payloads[0]!
    const snapshotPath = join(store.rootDirectory, manifest.id, payload.relativePath)
    expect(payload.relativePath).not.toContain(sourcePath)
    expect((await stat(store.rootDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(dirname(snapshotPath))).mode & 0o777).toBe(0o700)
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600)

    await rm(sourcePath)

    const reloadedStore = new PreparedSnapshotStore({ rootDirectory: store.rootDirectory })
    expect(await reloadedStore.get(manifest.id)).toEqual(manifest)
    expect((await reloadedStore.readPayload(manifest.id, payload.id)).contents).toEqual(contents)
    expect(
      toPreparedSnapshotView(
        manifest,
        (snapshotId, payloadId) => `snapshot://${snapshotId}/${payloadId}`,
      ).groups[0]!.items[0]!.previewUrl,
    ).toContain(manifest.id)
  })

  it('detects exact duplicates, permits forced copies, and allows same-name different content', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.webp')
    const firstContents = Buffer.from('first')
    await writeFile(sourcePath, firstContents)
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]
    const store = new PreparedSnapshotStore({
      rootDirectory: join(root, 'snapshots'),
      createId: () => ids.shift()!,
    })
    const first = preparation(sourcePath, firstContents, fingerprint('same'))
    const saved = await store.save(first)

    const duplicate = await store.save(first)
    expect(duplicate).toMatchObject({ kind: 'duplicate', manifest: { id: saved.manifest.id } })

    const forced = await store.save(first, true)
    expect(forced.kind).toBe('saved')
    expect(forced.manifest.id).not.toBe(saved.manifest.id)

    const secondContents = Buffer.from('different')
    await writeFile(sourcePath, secondContents)
    const sameNameDifferentContent = await store.save(
      preparation(sourcePath, secondContents, fingerprint('different')),
    )
    expect(sameNameDifferentContent.kind).toBe('saved')
    expect((await store.list()).map((item) => item.name)).toEqual([
      '同名结果',
      '同名结果',
      '同名结果',
    ])
  })

  it('rejects a snapshot whose copied payload was modified', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.png')
    const contents = Buffer.from('valid')
    await writeFile(sourcePath, contents)
    const store = new PreparedSnapshotStore({
      rootDirectory: join(root, 'snapshots'),
      createId: () => '44444444-4444-4444-4444-444444444444',
    })
    const saved = await store.save(preparation(sourcePath, contents, fingerprint('corrupt')))
    const payload = saved.manifest.groups[0]!.payloads[0]!
    await writeFile(join(store.rootDirectory, saved.manifest.id, payload.relativePath), 'tampered')

    await expect(store.get(saved.manifest.id)).rejects.toThrow(/checksum/)
  })

  it('saves the successfully prepared subset when individual assets fail or warnings exist', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.png')
    const contents = Buffer.from('subset payload')
    await writeFile(sourcePath, contents)
    const prepared = preparation(sourcePath, contents, fingerprint('partial'))
    prepared.orderedAssetIds = ['asset-a', 'asset-broken']
    prepared.warnings = ['分包余数已自动调整']
    prepared.assetFailures = [{ assetId: 'asset-broken', message: '转换失败' }]
    const store = new PreparedSnapshotStore({
      rootDirectory: join(root, 'snapshots'),
      createId: () => '55555555-5555-5555-5555-555555555555',
    })

    const saved = await store.save(prepared)
    expect(saved.kind).toBe('saved')
    expect(saved.manifest.orderedAssetIds).toEqual(['asset-a'])
    expect((await store.get(saved.manifest.id)).orderedAssetIds).toEqual(['asset-a'])
  })

  it('rejects preparations that contain a failed group', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.png')
    const contents = Buffer.from('failed group')
    await writeFile(sourcePath, contents)
    const prepared = preparation(sourcePath, contents, fingerprint('failed-group'))
    prepared.groups[0]!.status = 'failed'
    const store = new PreparedSnapshotStore({ rootDirectory: join(root, 'snapshots') })

    await expect(store.save(prepared)).rejects.toThrow(/准备失败的分组/)
  })
})

function preparation(
  sourcePath: string,
  contents: Buffer,
  contentFingerprint: string,
): PreparedExportResult {
  const checksum = createHash('sha256').update(contents).digest('hex')
  return {
    fingerprint: contentFingerprint,
    destination: 'local-folder',
    name: '同名结果',
    configuration: {
      kind: 'local-folder',
      batchName: '同名结果',
      format: 'original',
      naming: 'original',
      itemsPerFolder: 50,
    },
    orderedAssetIds: ['asset-a'],
    groups: [
      {
        id: 'local-group-a',
        name: '同名结果',
        mediaKind: 'static',
        assetIds: ['asset-a'],
        payloads: [
          {
            id: 'sticker-asset-a',
            role: 'sticker',
            assetId: 'asset-a',
            sourcePath,
            fileName: '表情.png',
            sha256: checksum,
            sizeBytes: contents.length,
            mimeType: 'image/png',
            animated: false,
          },
        ],
        status: 'prepared',
      },
    ],
    conversionVersion: 'local-original-v1',
    warnings: [],
    animationRepairs: [],
    assetFailures: [],
  }
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-snapshot-'))
  cleanup.push(directory)
  return directory
}
