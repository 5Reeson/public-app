import { createHash, randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  CURRENT_SCHEMA_VERSION,
  type StickerAsset,
  type StickerAssetSource,
  type StickerCollection,
  type StickerSourceKind,
} from '../../shared/domain.js'

const MANIFEST_FILE_NAME = 'manifest.json'
const BACKUP_FILE_NAME = `${MANIFEST_FILE_NAME}.bak`
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

export type DefaultCollectionSeed = Omit<
  StickerCollection,
  'schemaVersion' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<StickerCollection, 'schemaVersion' | 'createdAt' | 'updatedAt'>>

export interface ManifestStoreOptions {
  directory: string
  defaultCollection?: DefaultCollectionSeed
  now?: () => Date
}

export class ManifestReadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ManifestReadError'
  }
}

export class UnsupportedManifestSchemaError extends ManifestReadError {
  constructor(readonly schemaVersion: unknown) {
    super(
      `Unsupported collection manifest schema version: ${String(schemaVersion)}. ` +
        `Expected ${CURRENT_SCHEMA_VERSION}.`,
    )
    this.name = 'UnsupportedManifestSchemaError'
  }
}

/**
 * Small persistence boundary for one collection directory.
 *
 * Writes are committed by renaming a fully flushed file in the same directory.
 * Before replacing a valid primary manifest, its previous contents are retained
 * as manifest.json.bak. A corrupt primary never replaces a known-good backup.
 */
export class ManifestStore {
  readonly directory: string
  readonly manifestPath: string
  readonly backupPath: string

  private readonly defaultCollection?: DefaultCollectionSeed
  private readonly now: () => Date

  constructor(directoryOrOptions: string | ManifestStoreOptions) {
    const options =
      typeof directoryOrOptions === 'string'
        ? { directory: directoryOrOptions }
        : directoryOrOptions

    if (!options.directory) {
      throw new TypeError('ManifestStore requires a collection directory')
    }

    this.directory = options.directory
    this.manifestPath = join(this.directory, MANIFEST_FILE_NAME)
    this.backupPath = join(this.directory, BACKUP_FILE_NAME)
    this.defaultCollection = options.defaultCollection
    this.now = options.now ?? (() => new Date())
  }

  async load(): Promise<StickerCollection> {
    const primary = await this.tryRead(this.manifestPath)
    if (primary.kind === 'valid') {
      if (primary.migrated) {
        await this.copyFileAtomically(this.manifestPath, this.backupPath)
        await this.writeFileAtomically(this.manifestPath, serializeManifest(primary.collection))
      }
      return primary.collection
    }
    if (isUnsupportedSchema(primary)) throw primary.error

    const backup = await this.tryRead(this.backupPath)
    if (backup.kind === 'valid') {
      await this.writeFileAtomically(this.manifestPath, serializeManifest(backup.collection))
      return backup.collection
    }
    if (isUnsupportedSchema(backup)) throw backup.error

    throw this.buildReadError(primary, backup)
  }

  async loadOrCreate(seed = this.defaultCollection): Promise<StickerCollection> {
    const primary = await this.tryRead(this.manifestPath)
    if (primary.kind === 'valid') {
      if (primary.migrated) {
        await this.copyFileAtomically(this.manifestPath, this.backupPath)
        await this.writeFileAtomically(this.manifestPath, serializeManifest(primary.collection))
      }
      return primary.collection
    }
    if (isUnsupportedSchema(primary)) throw primary.error

    const backup = await this.tryRead(this.backupPath)
    if (backup.kind === 'valid') {
      await this.writeFileAtomically(this.manifestPath, serializeManifest(backup.collection))
      return backup.collection
    }
    if (isUnsupportedSchema(backup)) throw backup.error

    if (primary.kind !== 'missing' || backup.kind !== 'missing') {
      throw this.buildReadError(primary, backup)
    }

    const collection = createDefaultCollection(seed, this.now())
    await this.writeFileAtomically(this.manifestPath, serializeManifest(collection))
    return collection
  }

  async save(collection: StickerCollection): Promise<StickerCollection> {
    assertManifest(collection)
    const timestamp = this.now().toISOString()
    const normalized = normalizeWechatSourceLabels(collection).collection
    const candidate = {
      ...normalized,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: timestamp,
    }

    const serialized = serializeManifest(candidate)

    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })

    // Only rotate a primary that can itself be recovered. This deliberately
    // leaves an existing good backup untouched if the primary is corrupt.
    const primary = await this.tryRead(this.manifestPath)
    if (primary.kind === 'valid') {
      await this.copyFileAtomically(this.manifestPath, this.backupPath)
    }

    await this.writeFileAtomically(this.manifestPath, serialized)
    return candidate
  }

  private async tryRead(path: string): Promise<ReadResult> {
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { kind: 'missing' }
      return { kind: 'invalid', error }
    }

    try {
      const parsed: unknown = JSON.parse(source)
      if (isRecord(parsed) && parsed.schemaVersion === 1) {
        return { kind: 'valid', collection: migrateVersion1Manifest(parsed), migrated: true }
      }
      assertManifest(parsed)
      const normalized = normalizeWechatSourceLabels(parsed)
      return {
        kind: 'valid',
        collection: normalized.collection,
        migrated: normalized.changed,
      }
    } catch (error) {
      return { kind: 'invalid', error }
    }
  }

  private buildReadError(primary: ReadResult, backup: ReadResult): ManifestReadError {
    const schemaError = [primary, backup].find(isUnsupportedSchema)
    if (schemaError) return schemaError.error

    const primaryReason = describeReadResult(primary)
    const backupReason = describeReadResult(backup)
    return new ManifestReadError(
      `Could not load collection manifest (primary: ${primaryReason}; backup: ${backupReason}).`,
      primary.kind === 'invalid'
        ? primary.error
        : backup.kind === 'invalid'
          ? backup.error
          : undefined,
    )
  }

  private async writeFileAtomically(targetPath: string, contents: string): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true, mode: DIRECTORY_MODE })
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
      await syncDirectory(dirname(targetPath))
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if (!isNodeError(cleanupError, 'ENOENT')) throw cleanupError
      })
      throw error
    }
  }

  private async copyFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
    const temporaryPath = temporaryPathFor(targetPath)
    try {
      await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL)
      const handle = await open(temporaryPath, 'r+')
      try {
        await handle.chmod(FILE_MODE)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, targetPath)
      await syncDirectory(dirname(targetPath))
    } catch (error) {
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if (!isNodeError(cleanupError, 'ENOENT')) throw cleanupError
      })
      throw error
    }
  }
}

export function createDefaultCollection(
  seed: DefaultCollectionSeed | undefined,
  now = new Date(),
): StickerCollection {
  const timestamp = now.toISOString()
  const collection = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'default',
    title: '我的贴纸',
    publisher: '图渡',
    packSize: 30,
    assets: [],
    selectedAssetIds: [],
    ...seed,
    createdAt: seed?.createdAt ?? timestamp,
    updatedAt: seed?.updatedAt ?? timestamp,
  } satisfies StickerCollection

  assertManifest(collection)
  return collection
}

type ReadResult =
  | { kind: 'valid'; collection: StickerCollection; migrated: boolean }
  | { kind: 'missing' }
  | InvalidReadResult

type InvalidReadResult = { kind: 'invalid'; error: unknown }

function assertManifest(value: unknown): asserts value is StickerCollection {
  if (!isRecord(value)) throw new ManifestReadError('Collection manifest must be a JSON object')
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedManifestSchemaError(value.schemaVersion)
  }

  assertNonEmptyString(value.id, 'id')
  assertNonEmptyString(value.title, 'title')
  assertNonEmptyString(value.publisher, 'publisher')
  if (
    !Number.isInteger(value.packSize) ||
    (value.packSize as number) < 3 ||
    (value.packSize as number) > 30
  ) {
    throw new ManifestReadError('Collection manifest packSize must be an integer from 3 to 30')
  }
  if (!Array.isArray(value.assets)) {
    throw new ManifestReadError('Collection manifest assets must be an array')
  }
  for (const asset of value.assets) assertAsset(asset)
  if (!Array.isArray(value.selectedAssetIds) || !value.selectedAssetIds.every(isString)) {
    throw new ManifestReadError('Collection manifest selectedAssetIds must be a string array')
  }
  assertIsoTimestamp(value.createdAt, 'createdAt')
  assertIsoTimestamp(value.updatedAt, 'updatedAt')
}

function serializeManifest(collection: StickerCollection): string {
  const ancestors = new Set<object>()
  let serialized: string

  try {
    serialized = JSON.stringify(
      collection,
      function safeReplacer(key, value: unknown) {
        if (
          typeof value === 'bigint' ||
          typeof value === 'function' ||
          typeof value === 'symbol' ||
          value === undefined
        ) {
          throw new TypeError(`Manifest contains a non-JSON value at ${key || '<root>'}`)
        }

        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new TypeError(`Manifest contains a non-finite number at ${key || '<root>'}`)
        }

        if (value && typeof value === 'object') {
          while (ancestors.size > 0 && !ancestors.has(this as object)) {
            const last = Array.from(ancestors).at(-1)
            if (last) ancestors.delete(last)
          }
          if (ancestors.has(value)) {
            throw new TypeError(`Manifest contains a circular reference at ${key || '<root>'}`)
          }
          ancestors.add(value)
        }

        return value
      },
      2,
    )
  } catch (error) {
    throw new ManifestReadError('Collection manifest is not safely serializable', error)
  }

  return `${serialized}\n`
}

function temporaryPathFor(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Some filesystems/platforms do not permit opening or syncing directories.
    if (
      !isNodeError(error, 'EINVAL') &&
      !isNodeError(error, 'EPERM') &&
      !isNodeError(error, 'ENOTSUP') &&
      !isNodeError(error, 'EISDIR')
    ) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAsset(value: unknown): void {
  if (!isRecord(value)) throw new ManifestReadError('Each collection asset must be a JSON object')
  assertNonEmptyString(value.id, 'assets[].id')
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new ManifestReadError('Collection manifest assets[].sources must be a non-empty array')
  }
  for (const source of value.sources) assertAssetSource(source)
  if (
    new Set(value.sources.map((source) => (source as StickerAssetSource).id)).size !==
    value.sources.length
  ) {
    throw new ManifestReadError('Collection manifest assets[].sources IDs must be unique')
  }
  assertNonEmptyString(value.displayName, 'assets[].displayName')
  assertNonEmptyString(value.originalPath, 'assets[].originalPath')
  assertNonEmptyString(value.sha256, 'assets[].sha256')
  assertNonEmptyString(value.mimeType, 'assets[].mimeType')
  if (typeof value.animated !== 'boolean') {
    throw new ManifestReadError('Collection manifest assets[].animated must be a boolean')
  }
  assertNonNegativeInteger(value.width, 'assets[].width')
  assertNonNegativeInteger(value.height, 'assets[].height')
  if (value.durationMs !== undefined) {
    assertNonNegativeInteger(value.durationMs, 'assets[].durationMs')
  }
  assertIsoTimestamp(value.importedAt, 'assets[].importedAt')
  assertNonNegativeInteger(value.sourceOrder, 'assets[].sourceOrder')
  assertNonNegativeInteger(value.userOrder, 'assets[].userOrder')
}

function assertAssetSource(value: unknown): asserts value is StickerAssetSource {
  if (!isRecord(value)) {
    throw new ManifestReadError('Each collection asset source must be a JSON object')
  }
  assertNonEmptyString(value.id, 'assets[].sources[].id')
  if (!isSourceKind(value.kind)) {
    throw new ManifestReadError('Collection manifest assets[].sources[].kind is invalid')
  }
  assertNonEmptyString(value.label, 'assets[].sources[].label')
  if (value.accountId !== undefined) {
    assertNonEmptyString(value.accountId, 'assets[].sources[].accountId')
  }
  if (value.importBatchId !== undefined) {
    assertNonEmptyString(value.importBatchId, 'assets[].sources[].importBatchId')
  }
  if (value.album !== undefined) {
    if (!isRecord(value.album)) {
      throw new ManifestReadError('Collection manifest assets[].sources[].album is invalid')
    }
    if (value.album.kind !== 'personal' && value.album.kind !== 'official') {
      throw new ManifestReadError('Collection manifest assets[].sources[].album.kind is invalid')
    }
    assertNonEmptyString(value.album.id, 'assets[].sources[].album.id')
    assertNonEmptyString(value.album.name, 'assets[].sources[].album.name')
  }
  assertIsoTimestamp(value.importedAt, 'assets[].sources[].importedAt')
}

function isSourceKind(value: unknown): value is StickerSourceKind {
  return value === 'local' || value === 'wechat4' || value === 'wechat-legacy'
}

function legacySourceId(kind: StickerSourceKind, accountId: string | undefined): string {
  const identity = accountId ?? 'legacy-local-imports'
  return `source-${createHash('sha256').update(`${kind}|${identity}`).digest('hex').slice(0, 24)}`
}

function legacySourceLabel(kind: StickerSourceKind, accountId: string | undefined): string {
  if (kind === 'local') return '旧版本机导入'
  const suffix = accountId ? ` · ${accountId.slice(-4)}` : ''
  return `${kind === 'wechat4' ? '新版微信账号' : '旧版微信账号'}${suffix}`
}

function normalizedWechatSourceLabel(source: StickerAssetSource): string {
  if (source.kind === 'wechat4') {
    return source.label.replace(/^微信\s*4\.x\s*账号/, '新版微信账号')
  }
  if (source.kind === 'wechat-legacy') {
    return source.label
      .replace(/^微信旧版账号/, '旧版微信账号')
      .replace(/^微信账号/, '旧版微信账号')
  }
  return source.label
}

function normalizeWechatSourceLabels(collection: StickerCollection): {
  collection: StickerCollection
  changed: boolean
} {
  let changed = false
  const assets = collection.assets.map((asset) => {
    const sources = asset.sources.map((source) => {
      const label = normalizedWechatSourceLabel(source)
      if (label === source.label) return source
      changed = true
      return { ...source, label }
    })
    return sources.every((source, index) => source === asset.sources[index])
      ? asset
      : { ...asset, sources }
  })
  return changed ? { collection: { ...collection, assets }, changed } : { collection, changed }
}

function migrateVersion1Manifest(value: Record<string, unknown>): StickerCollection {
  assertLegacyVersion1Manifest(value)
  const assets = value.assets.map((asset): StickerAsset => {
    const { sourceKind, sourceAccountId, ...rest } = asset
    const source: StickerAssetSource = {
      id: legacySourceId(sourceKind, sourceAccountId),
      kind: sourceKind,
      label: legacySourceLabel(sourceKind, sourceAccountId),
      ...(sourceAccountId === undefined ? {} : { accountId: sourceAccountId }),
      ...(sourceKind === 'local' ? { importBatchId: 'legacy-local-imports' } : {}),
      importedAt: asset.importedAt,
    }
    return { ...rest, sources: [source] }
  })
  const migrated = { ...value, schemaVersion: CURRENT_SCHEMA_VERSION, assets }
  assertManifest(migrated)
  return migrated
}

function assertLegacyVersion1Manifest(value: Record<string, unknown>): asserts value is Record<
  string,
  unknown
> & {
  assets: Array<
    Omit<StickerAsset, 'sources'> & {
      sourceKind: StickerSourceKind
      sourceAccountId?: string
    }
  >
} {
  assertNonEmptyString(value.id, 'id')
  assertNonEmptyString(value.title, 'title')
  assertNonEmptyString(value.publisher, 'publisher')
  if (
    !Number.isInteger(value.packSize) ||
    (value.packSize as number) < 3 ||
    (value.packSize as number) > 30
  ) {
    throw new ManifestReadError('Collection manifest packSize must be an integer from 3 to 30')
  }
  if (!Array.isArray(value.assets)) {
    throw new ManifestReadError('Collection manifest assets must be an array')
  }
  for (const asset of value.assets) {
    if (!isRecord(asset)) throw new ManifestReadError('Each collection asset must be an object')
    if (!isSourceKind(asset.sourceKind)) {
      throw new ManifestReadError('Collection manifest assets[].sourceKind is invalid')
    }
    if (asset.sourceAccountId !== undefined) {
      assertNonEmptyString(asset.sourceAccountId, 'assets[].sourceAccountId')
    }
    const currentShape: Record<string, unknown> = { ...asset }
    delete currentShape.sourceKind
    delete currentShape.sourceAccountId
    assertAsset({
      ...currentShape,
      sources: [
        {
          id: 'legacy-validation',
          kind: asset.sourceKind,
          label: 'Legacy validation',
          importedAt: asset.importedAt,
        },
      ],
    })
  }
  if (!Array.isArray(value.selectedAssetIds) || !value.selectedAssetIds.every(isString)) {
    throw new ManifestReadError('Collection manifest selectedAssetIds must be a string array')
  }
  assertIsoTimestamp(value.createdAt, 'createdAt')
  assertIsoTimestamp(value.updatedAt, 'updatedAt')
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ManifestReadError(`Collection manifest ${field} must be a non-negative integer`)
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManifestReadError(`Collection manifest ${field} must be a non-empty string`)
  }
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ManifestReadError(`Collection manifest ${field} must be an ISO timestamp`)
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function describeReadResult(result: ReadResult): string {
  if (result.kind === 'missing') return 'missing'
  if (result.kind === 'valid') return 'valid'
  return result.error instanceof Error ? result.error.message : String(result.error)
}

function isUnsupportedSchema(
  result: ReadResult,
): result is InvalidReadResult & { error: UnsupportedManifestSchemaError } {
  return result.kind === 'invalid' && result.error instanceof UnsupportedManifestSchemaError
}
