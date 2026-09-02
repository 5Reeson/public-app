import { randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  CURRENT_EXPORT_TASK_SCHEMA_VERSION,
  type ExportTask,
  type ExportTaskDraft,
  type ExportTaskPreparedState,
} from '../../shared/domain.js'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

export interface ExportTaskStoreOptions {
  path: string
  now?: () => Date
  createId?: () => string
}

export class ExportTaskReadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ExportTaskReadError'
  }
}

export class UnsupportedExportTaskSchemaError extends ExportTaskReadError {
  constructor(readonly schemaVersion: unknown) {
    super(`Unsupported export task schema version: ${String(schemaVersion)}`)
    this.name = 'UnsupportedExportTaskSchemaError'
  }
}

export class ExportTaskStore {
  readonly path: string
  readonly backupPath: string

  private readonly now: () => Date
  private readonly createId: () => string

  constructor(options: ExportTaskStoreOptions) {
    if (!options.path) throw new TypeError('ExportTaskStore requires a file path')
    this.path = options.path
    this.backupPath = `${options.path}.bak`
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async load(): Promise<ExportTask> {
    const primary = await this.tryRead(this.path)
    if (primary.kind === 'valid') {
      return primary.task
    }
    if (primary.kind === 'legacy') return this.migratePrimary(primary.task)
    if (isUnsupported(primary)) throw primary.error

    const backup = await this.tryRead(this.backupPath)
    if (backup.kind === 'valid') {
      await this.writeAtomically(this.path, serialize(backup.task))
      return backup.task
    }
    if (backup.kind === 'legacy') {
      const migrated = migrateV1Task(backup.task)
      await this.writeAtomically(this.path, serialize(migrated))
      return migrated
    }
    if (isUnsupported(backup)) throw backup.error
    throw new ExportTaskReadError(
      `Could not load export task (primary: ${describe(primary)}; backup: ${describe(backup)})`,
      primary.kind === 'invalid'
        ? primary.error
        : backup.kind === 'invalid'
          ? backup.error
          : undefined,
    )
  }

  async loadOrCreate(): Promise<ExportTask> {
    const primary = await this.tryRead(this.path)
    if (primary.kind === 'valid') {
      return primary.task
    }
    if (primary.kind === 'legacy') return this.migratePrimary(primary.task)
    if (isUnsupported(primary)) throw primary.error

    const backup = await this.tryRead(this.backupPath)
    if (backup.kind === 'valid') {
      await this.writeAtomically(this.path, serialize(backup.task))
      return backup.task
    }
    if (backup.kind === 'legacy') {
      const migrated = migrateV1Task(backup.task)
      await this.writeAtomically(this.path, serialize(migrated))
      return migrated
    }
    if (isUnsupported(backup)) throw backup.error
    if (primary.kind !== 'missing' || backup.kind !== 'missing') return this.load()

    const task = createDefaultExportTask(this.now(), this.createId())
    await this.writeAtomically(this.path, serialize(task))
    return task
  }

  async save(task: ExportTask): Promise<ExportTask> {
    assertExportTask(task)
    const current = await this.loadOrCreate()
    const timestamp = this.now().toISOString()
    const candidate: ExportTask = {
      ...task,
      schemaVersion: CURRENT_EXPORT_TASK_SCHEMA_VERSION,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    }
    assertExportTask(candidate)

    await this.copyAtomically(this.path, this.backupPath)
    await this.writeAtomically(this.path, serialize(candidate))
    return candidate
  }

  async saveDraft(draft: ExportTaskDraft): Promise<ExportTask> {
    const current = await this.loadOrCreate()
    const candidate: ExportTask = {
      ...current,
      ...draft,
      ...(preparationInputsChanged(current, draft) ? { prepared: undefined } : {}),
    }
    assertExportTask(candidate)
    return this.save(candidate)
  }

  async reset(): Promise<ExportTask> {
    await this.loadOrCreate()
    const replacement = createDefaultExportTask(this.now(), this.createId())
    await this.copyAtomically(this.path, this.backupPath)
    await this.writeAtomically(this.path, serialize(replacement))
    return replacement
  }

  async setPrepared(prepared: ExportTaskPreparedState): Promise<ExportTask> {
    const current = await this.loadOrCreate()
    return this.save({ ...current, prepared })
  }

  async attachSnapshot(fingerprint: string, snapshotId: string): Promise<ExportTask> {
    const current = await this.loadOrCreate()
    if (!current.prepared || current.prepared.fingerprint !== fingerprint) {
      throw new ExportTaskReadError('Prepared snapshot no longer matches the current export task')
    }
    return this.save({
      ...current,
      prepared: { ...current.prepared, snapshotId },
    })
  }

  async reconcileAssets(knownAssetIds: ReadonlySet<string>): Promise<ExportTask> {
    const current = await this.loadOrCreate()
    const selectedAssetIds = current.selectedAssetIds.filter((id) => knownAssetIds.has(id))
    const orderedAssetIds = current.orderedAssetIds.filter((id) => knownAssetIds.has(id))
    if (
      selectedAssetIds.length === current.selectedAssetIds.length &&
      orderedAssetIds.length === current.orderedAssetIds.length
    ) {
      return current
    }
    return this.save({
      ...current,
      selectedAssetIds,
      orderedAssetIds,
      prepared: undefined,
    })
  }

  private async tryRead(path: string): Promise<ReadResult> {
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      return isNodeError(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid', error }
    }
    try {
      const parsed: unknown = JSON.parse(source)
      if (isRecord(parsed) && parsed.schemaVersion === 1) {
        assertV1ExportTask(parsed)
        return { kind: 'legacy', task: parsed }
      }
      assertExportTask(parsed)
      return { kind: 'valid', task: parsed }
    } catch (error) {
      return { kind: 'invalid', error }
    }
  }

  private async migratePrimary(task: ExportTaskV1): Promise<ExportTask> {
    const migrated = migrateV1Task(task)
    await this.copyAtomically(this.path, this.backupPath)
    await this.writeAtomically(this.path, serialize(migrated))
    return migrated
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
      await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL)
      await chmod(temporaryPath, FILE_MODE)
      await rename(temporaryPath, targetPath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

export function createDefaultExportTask(now = new Date(), id: string = randomUUID()): ExportTask {
  const timestamp = now.toISOString()
  return {
    schemaVersion: CURRENT_EXPORT_TASK_SCHEMA_VERSION,
    id: `export-task-${id}`,
    currentStep: 1,
    selectedAssetIds: [],
    orderedAssetIds: [],
    whatsapp: { title: '我的表情', publisher: '图渡', packSize: 30 },
    localFolder: {
      batchName: '本地导出',
      format: 'original',
      naming: 'original',
      itemsPerFolder: 50,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function assertExportTask(value: unknown): asserts value is ExportTask {
  if (!isRecord(value)) throw new ExportTaskReadError('Export task must be a JSON object')
  if (value.schemaVersion !== CURRENT_EXPORT_TASK_SCHEMA_VERSION) {
    throw new UnsupportedExportTaskSchemaError(value.schemaVersion)
  }
  assertNonEmptyString(value.id, 'id')
  if (![1, 2, 3, 4].includes(value.currentStep as number)) {
    throw new ExportTaskReadError('Export task currentStep must be 1–4')
  }
  assertStringArray(value.selectedAssetIds, 'selectedAssetIds')
  assertStringArray(value.orderedAssetIds, 'orderedAssetIds')
  if (new Set(value.selectedAssetIds).size !== value.selectedAssetIds.length) {
    throw new ExportTaskReadError('Export task selectedAssetIds must be unique')
  }
  if (new Set(value.orderedAssetIds).size !== value.orderedAssetIds.length) {
    throw new ExportTaskReadError('Export task orderedAssetIds must be unique')
  }
  const selected = new Set(value.selectedAssetIds)
  if (
    value.orderedAssetIds.length !== value.selectedAssetIds.length ||
    value.orderedAssetIds.some((id) => !selected.has(id))
  ) {
    throw new ExportTaskReadError(
      'Export task order must contain every selected asset exactly once',
    )
  }
  assertSource(value.source)
  assertDestination(value.destination)
  assertWhatsappSettings(value.whatsapp)
  assertLocalFolderSettings(value.localFolder)
  assertPrepared(value.prepared)
  assertTimestamp(value.createdAt, 'createdAt')
  assertTimestamp(value.updatedAt, 'updatedAt')
}

function assertSource(value: unknown): void {
  if (value === undefined) return
  if (
    !isRecord(value) ||
    !['library', 'local', 'wechat4', 'wechat-legacy'].includes(String(value.kind))
  ) {
    throw new ExportTaskReadError('Export task source is invalid')
  }
  assertNonEmptyString(value.label, 'source.label')
  if (value.label.length > 128)
    throw new ExportTaskReadError('Export task source label is too long')
  if (value.kind === 'wechat4' || value.kind === 'wechat-legacy') {
    assertNonEmptyString(value.sourceAccountId, 'source.sourceAccountId')
    const expectedPrefix = value.kind === 'wechat4' ? 'wechat4-' : 'wechat-legacy-'
    if (!new RegExp(`^${expectedPrefix}[a-f0-9]{16}$`).test(value.sourceAccountId)) {
      throw new ExportTaskReadError('Export task source account ID must be opaque')
    }
  }
  if (value.importBatchId !== undefined) {
    assertNonEmptyString(value.importBatchId, 'source.importBatchId')
    if (value.importBatchId.length > 256) {
      throw new ExportTaskReadError('Export task source import batch ID is too long')
    }
  }
}

function assertDestination(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || (value.kind !== 'whatsapp' && value.kind !== 'local-folder')) {
    throw new ExportTaskReadError('Export task destination is invalid')
  }
  if (value.directoryId !== undefined) {
    assertNonEmptyString(value.directoryId, 'destination.directoryId')
    if (!/^export-directory-[a-f0-9-]{36}$/.test(value.directoryId)) {
      throw new ExportTaskReadError('Export task directory ID must be opaque')
    }
  }
  if (value.directoryLabel !== undefined) {
    assertNonEmptyString(value.directoryLabel, 'destination.directoryLabel')
    if (value.directoryLabel.length > 128) {
      throw new ExportTaskReadError('Export task directory label is too long')
    }
  }
}

function assertWhatsappSettings(value: unknown): void {
  if (!isRecord(value)) throw new ExportTaskReadError('Export task whatsapp settings are invalid')
  assertNonEmptyString(value.title, 'whatsapp.title')
  assertNonEmptyString(value.publisher, 'whatsapp.publisher')
  if (value.title.length > 128 || value.publisher.length > 128) {
    throw new ExportTaskReadError(
      'Export task whatsapp title and publisher must be at most 128 characters',
    )
  }
  if (
    !Number.isInteger(value.packSize) ||
    (value.packSize as number) < 3 ||
    (value.packSize as number) > 30
  ) {
    throw new ExportTaskReadError('Export task whatsapp.packSize must be 3–30')
  }
}

function assertLocalFolderSettings(value: unknown): void {
  if (!isRecord(value))
    throw new ExportTaskReadError('Export task localFolder settings are invalid')
  assertNonEmptyString(value.batchName, 'localFolder.batchName')
  if (value.batchName.length > 128) {
    throw new ExportTaskReadError(
      'Export task localFolder.batchName must be at most 128 characters',
    )
  }
  if (value.format !== 'original' && value.format !== 'converted-webp') {
    throw new ExportTaskReadError('Export task localFolder.format is invalid')
  }
  if (value.naming !== 'original' && value.naming !== 'sequence') {
    throw new ExportTaskReadError('Export task localFolder.naming is invalid')
  }
  if (
    !Number.isInteger(value.itemsPerFolder) ||
    (value.itemsPerFolder as number) < 1 ||
    (value.itemsPerFolder as number) > 10_000
  ) {
    throw new ExportTaskReadError('Export task localFolder.itemsPerFolder is invalid')
  }
}

function assertPrepared(value: unknown): void {
  if (value === undefined) return
  if (
    !isRecord(value) ||
    !['preparing', 'prepared', 'partial-failure', 'complete'].includes(String(value.status))
  ) {
    throw new ExportTaskReadError('Export task prepared state is invalid')
  }
  assertNonEmptyString(value.fingerprint, 'prepared.fingerprint')
  if (value.snapshotId !== undefined) assertNonEmptyString(value.snapshotId, 'prepared.snapshotId')
  if (value.preparedAt !== undefined) assertTimestamp(value.preparedAt, 'prepared.preparedAt')
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new ExportTaskReadError(`Export task ${field} must be a string array`)
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExportTaskReadError(`Export task ${field} must be a non-empty string`)
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ExportTaskReadError(`Export task ${field} must be an ISO timestamp`)
  }
}

function serialize(task: ExportTask): string {
  return `${JSON.stringify(task, null, 2)}\n`
}

function temporaryPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
}

type ReadResult =
  | { kind: 'valid'; task: ExportTask }
  | { kind: 'legacy'; task: ExportTaskV1 }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: unknown }

function isUnsupported(
  result: ReadResult,
): result is { kind: 'invalid'; error: UnsupportedExportTaskSchemaError } {
  return result.kind === 'invalid' && result.error instanceof UnsupportedExportTaskSchemaError
}

function describe(result: ReadResult): string {
  if (result.kind !== 'invalid') return result.kind
  return result.error instanceof Error ? result.error.message : String(result.error)
}

interface ExportTaskV1 extends Omit<ExportTask, 'schemaVersion' | 'localFolder'> {
  schemaVersion: 1
  localFolder: Omit<ExportTask['localFolder'], 'batchName'>
}

function assertV1ExportTask(value: unknown): asserts value is ExportTaskV1 {
  if (!isRecord(value)) throw new ExportTaskReadError('Legacy export task must be an object')
  const localFolder = value.localFolder
  if (!isRecord(localFolder)) {
    throw new ExportTaskReadError('Legacy export task localFolder settings are invalid')
  }
  const candidate = {
    ...value,
    schemaVersion: CURRENT_EXPORT_TASK_SCHEMA_VERSION,
    localFolder: { ...localFolder, batchName: '本地导出' },
  }
  assertExportTask(candidate)
}

function migrateV1Task(task: ExportTaskV1): ExportTask {
  return {
    ...task,
    schemaVersion: CURRENT_EXPORT_TASK_SCHEMA_VERSION,
    localFolder: { ...task.localFolder, batchName: '本地导出' },
  }
}

function preparationInputsChanged(current: ExportTask, draft: ExportTaskDraft): boolean {
  return (
    !sameJson(current.source, draft.source) ||
    !sameJson(current.destination, draft.destination) ||
    !sameJson(current.selectedAssetIds, draft.selectedAssetIds) ||
    !sameJson(current.orderedAssetIds, draft.orderedAssetIds) ||
    !sameJson(current.whatsapp, draft.whatsapp) ||
    !sameJson(current.localFolder, draft.localFolder)
  )
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
