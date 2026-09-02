import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writePreparedLocalExport } from '../../src/main/exports/local-export-writer.js'
import type { PreparedExportResult } from '../../src/main/exports/export-preparer.js'

describe('writePreparedLocalExport', () => {
  it('writes groups into a unique immutable batch folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-export-writer-'))
    const source = join(root, 'source.webp')
    await writeFile(source, 'prepared-payload')
    const prepared = fixture(source)

    const first = await writePreparedLocalExport(prepared, root)
    const second = await writePreparedLocalExport(prepared, root)

    expect(first).toEqual({ directoryLabel: '周末表情', groupCount: 1, assetCount: 1 })
    expect(second.directoryLabel).toBe('周末表情 2')
    expect(await readFile(join(root, first.directoryLabel, '周末表情 1', '001.webp'), 'utf8')).toBe(
      'prepared-payload',
    )
    expect(
      (await stat(join(root, first.directoryLabel, '周末表情 1', '001.webp'))).mode & 0o777,
    ).toBe(0o600)
    expect((await readdir(join(root, first.directoryLabel))).sort()).toEqual(['周末表情 1'])
  })

  it('rejects partial preparation without leaving a batch folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-export-writer-failed-'))
    const source = join(root, 'source.webp')
    await writeFile(source, 'payload')
    const prepared = fixture(source)
    prepared.groups[0]!.status = 'failed'

    await expect(writePreparedLocalExport(prepared, root)).rejects.toThrow('准备结果仍有失败')
    expect((await readdir(root)).sort()).toEqual(['source.webp'])
  })
})

function fixture(sourcePath: string): PreparedExportResult {
  return {
    fingerprint: 'a'.repeat(64),
    destination: 'local-folder',
    name: '周末表情',
    configuration: {
      kind: 'local-folder',
      batchName: '周末表情',
      format: 'converted-webp',
      naming: 'sequence',
      itemsPerFolder: 50,
    },
    orderedAssetIds: ['asset-1'],
    groups: [
      {
        id: 'group-1',
        name: '周末表情 1',
        mediaKind: 'mixed',
        assetIds: ['asset-1'],
        status: 'prepared',
        payloads: [
          {
            id: 'payload-1',
            role: 'sticker',
            assetId: 'asset-1',
            sourcePath,
            fileName: '001.webp',
            sha256: 'b'.repeat(64),
            sizeBytes: 16,
            mimeType: 'image/webp',
            animated: false,
          },
        ],
      },
    ],
    conversionVersion: 'test-v1',
    warnings: [],
    animationRepairs: [],
    assetFailures: [],
  }
}
