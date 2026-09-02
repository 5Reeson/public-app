import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { LocalExportSummary } from '../../shared/domain.js'
import type { PreparedExportResult } from './export-preparer.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export async function writePreparedLocalExport(
  prepared: PreparedExportResult,
  destinationDirectory: string,
): Promise<LocalExportSummary> {
  if (prepared.destination !== 'local-folder') throw new Error('当前准备结果不是本地导出')
  if (
    prepared.groups.length === 0 ||
    prepared.groups.some((group) => group.status !== 'prepared') ||
    prepared.assetFailures.length > 0
  ) {
    throw new Error('准备结果仍有失败，不能开始本地导出')
  }
  if (!(await stat(destinationDirectory)).isDirectory()) throw new Error('本地导出位置已失效')

  const folderName = await availableFolderName(destinationDirectory, safeName(prepared.name))
  const temporaryName = `.${folderName}.${process.pid}.${randomUUID()}.tmp`
  const temporaryDirectory = join(destinationDirectory, temporaryName)
  const targetDirectory = join(destinationDirectory, folderName)
  await mkdir(temporaryDirectory, { mode: DIRECTORY_MODE })
  let assetCount = 0
  try {
    for (const [groupIndex, group] of prepared.groups.entries()) {
      const groupName = safeName(group.name || `${prepared.name} ${groupIndex + 1}`)
      const groupDirectory = join(temporaryDirectory, groupName)
      await mkdir(groupDirectory, { mode: DIRECTORY_MODE })
      for (const payload of group.payloads.filter((item) => item.role === 'sticker')) {
        const targetPath = join(groupDirectory, basename(payload.fileName))
        await copyFile(payload.sourcePath, targetPath)
        await chmod(targetPath, FILE_MODE)
        assetCount += 1
      }
    }
    await rename(temporaryDirectory, targetDirectory)
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    directoryLabel: folderName,
    groupCount: prepared.groups.length,
    assetCount,
  }
}

async function availableFolderName(parent: string, requested: string): Promise<string> {
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = suffix === 1 ? requested : `${requested} ${suffix}`
    try {
      await stat(join(parent, candidate))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('无法为本地导出创建唯一文件夹')
}

function safeName(value: string): string {
  const safe = [...value]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .normalize('NFC')
    .replaceAll(/[/:\\]/g, '-')
    .replaceAll(/^\.+|\.+$/g, '')
    .trim()
  return (safe || '本地导出').slice(0, 96)
}
