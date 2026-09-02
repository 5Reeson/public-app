import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { ExportDestinationChoice } from '../../shared/domain.js'

const SCHEMA_VERSION = 1 as const
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

interface StoredDirectory {
  id: string
  label: string
  path: string
  addedAt: string
}

interface DestinationFile {
  schemaVersion: typeof SCHEMA_VERSION
  directories: StoredDirectory[]
}

export interface ExportDestinationStoreOptions {
  path: string
  now?: () => Date
  createId?: () => string
}

export class UnsupportedExportDestinationSchemaError extends Error {
  constructor(readonly schemaVersion: unknown) {
    super(`Unsupported export destination schema version: ${String(schemaVersion)}`)
    this.name = 'UnsupportedExportDestinationSchemaError'
  }
}

export class ExportDestinationStore {
  private readonly path: string
  private readonly backupPath: string
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(options: ExportDestinationStoreOptions) {
    if (!options.path) throw new TypeError('ExportDestinationStore requires a file path')
    this.path = options.path
    this.backupPath = `${options.path}.bak`
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async rememberDirectory(selectedPath: string): Promise<ExportDestinationChoice> {
    const resolvedPath = await realpath(selectedPath)
    if (!(await stat(resolvedPath)).isDirectory()) throw new Error('所选导出位置不是文件夹')
    const file = await this.loadOrCreate()
    const existing = file.directories.find((directory) => directory.path === resolvedPath)
    if (existing) return toChoice(existing)

    const directory: StoredDirectory = {
      id: `export-directory-${this.createId()}`,
      label: safeDirectoryLabel(resolvedPath),
      path: resolvedPath,
      addedAt: this.now().toISOString(),
    }
    assertStoredDirectory(directory)
    await this.save({ ...file, directories: [...file.directories, directory] })
    return toChoice(directory)
  }

  async getChoice(id: string): Promise<ExportDestinationChoice | undefined> {
    const directory = (await this.loadOrCreate()).directories.find((item) => item.id === id)
    return directory ? toChoice(directory) : undefined
  }

  async getDirectoryPath(id: string): Promise<string | undefined> {
    return (await this.loadOrCreate()).directories.find((item) => item.id === id)?.path
  }

  async resolveDirectory(id: string): Promise<string> {
    const directory = (await this.loadOrCreate()).directories.find((item) => item.id === id)
    if (!directory) throw new Error('本地导出位置已失效，请重新选择')
    try {
      if (!(await stat(directory.path)).isDirectory()) throw new Error('Not a directory')
    } catch {
      throw new Error('本地导出位置已失效，请重新选择')
    }
    return directory.path
  }

  private async loadOrCreate(): Promise<DestinationFile> {
    const primary = await this.tryRead(this.path)
    if (primary.kind === 'valid') return primary.file
    if (isUnsupported(primary)) throw primary.error
    const backup = await this.tryRead(this.backupPath)
    if (backup.kind === 'valid') {
      await this.writeAtomically(this.path, serialize(backup.file))
      return backup.file
    }
    if (isUnsupported(backup)) throw backup.error
    if (primary.kind === 'invalid') throw primary.error
    if (backup.kind === 'invalid') throw backup.error
    const empty: DestinationFile = { schemaVersion: SCHEMA_VERSION, directories: [] }
    await this.writeAtomically(this.path, serialize(empty))
    return empty
  }

  private async save(file: DestinationFile): Promise<void> {
    assertDestinationFile(file)
    if (await fileExists(this.path)) await this.copyAtomically(this.path, this.backupPath)
    await this.writeAtomically(this.path, serialize(file))
  }

  private async tryRead(path: string): Promise<DestinationReadResult> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      assertDestinationFile(parsed)
      return { kind: 'valid', file: parsed }
    } catch (error) {
      return isNodeError(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid', error }
    }
  }

  private async writeAtomically(targetPath: string, contents: string): Promise<void> {
    const directory = dirname(targetPath)
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(directory, DIRECTORY_MODE)
    const temporaryPath = temporaryPathFor(targetPath)
    try {
      const handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      )
      try {
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, targetPath)
      await chmod(targetPath, FILE_MODE)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async copyAtomically(sourcePath: string, targetPath: string): Promise<void> {
    const temporaryPath = temporaryPathFor(targetPath)
    try {
      await copyFile(sourcePath, temporaryPath)
      await chmod(temporaryPath, FILE_MODE)
      await rename(temporaryPath, targetPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

function toChoice(directory: StoredDirectory): ExportDestinationChoice {
  return {
    kind: 'local-folder',
    directoryId: directory.id,
    directoryLabel: directory.label,
  }
}

function safeDirectoryLabel(path: string): string {
  const label = basename(path).trim()
  return label && label !== '/' ? label.slice(0, 128) : '所选文件夹'
}

function assertDestinationFile(value: unknown): asserts value is DestinationFile {
  if (!isRecord(value)) throw new Error('Invalid export destination file')
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new UnsupportedExportDestinationSchemaError(value.schemaVersion)
  }
  if (!Array.isArray(value.directories) || value.directories.length > 1_000) {
    throw new Error('Invalid export destination list')
  }
  value.directories.forEach(assertStoredDirectory)
  if (
    new Set(value.directories.map((directory) => directory.id)).size !== value.directories.length
  ) {
    throw new Error('Export destination IDs must be unique')
  }
}

function assertStoredDirectory(value: unknown): asserts value is StoredDirectory {
  if (!isRecord(value)) throw new Error('Invalid export destination')
  if (
    typeof value.id !== 'string' ||
    !/^export-directory-[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > 128 ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    typeof value.addedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.addedAt))
  ) {
    throw new Error('Invalid export destination')
  }
}

function serialize(value: DestinationFile): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function temporaryPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

type DestinationReadResult =
  | { kind: 'valid'; file: DestinationFile }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: unknown }

function isUnsupported(
  result: DestinationReadResult,
): result is { kind: 'invalid'; error: UnsupportedExportDestinationSchemaError } {
  return (
    result.kind === 'invalid' && result.error instanceof UnsupportedExportDestinationSchemaError
  )
}
