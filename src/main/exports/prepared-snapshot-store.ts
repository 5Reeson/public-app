import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  CURRENT_PREPARED_SNAPSHOT_SCHEMA_VERSION,
  type PreparedExportGroupView,
  type PreparedSnapshotConfiguration,
  type PreparedSnapshotManifest,
  type PreparedSnapshotPayload,
  type PreparedSnapshotSummary,
  type PreparedSnapshotView,
} from '../../shared/domain.js'
import type {
  PreparedExportGroup,
  PreparedExportPayload as PreparedPayloadInput,
  PreparedExportResult,
} from './export-preparer.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const SNAPSHOT_ID_PATTERN = /^snapshot-[a-f0-9-]{36}$/

export interface PreparedSnapshotStoreOptions {
  rootDirectory: string
  now?: () => Date
  createId?: () => string
}

export type SnapshotSaveResult =
  | { kind: 'saved'; manifest: PreparedSnapshotManifest }
  | { kind: 'duplicate'; manifest: PreparedSnapshotManifest }

export class PreparedSnapshotStore {
  readonly rootDirectory: string
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(options: PreparedSnapshotStoreOptions) {
    if (!options.rootDirectory)
      throw new TypeError('PreparedSnapshotStore requires a root directory')
    this.rootDirectory = resolve(options.rootDirectory)
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async save(prepared: PreparedExportResult, forceDuplicate = false): Promise<SnapshotSaveResult> {
    const orderedAssetIds = assertSavablePreparation(prepared)
    const existing = (await this.list()).find(
      (snapshot) => snapshot.contentFingerprint === prepared.fingerprint,
    )
    if (existing && !forceDuplicate) {
      try {
        return { kind: 'duplicate', manifest: await this.get(existing.id) }
      } catch {
        // A corrupt matching snapshot must not prevent saving a healthy replacement.
      }
    }

    await mkdir(this.rootDirectory, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(this.rootDirectory, DIRECTORY_MODE)
    const id = `snapshot-${this.createId()}`
    assertSnapshotId(id)
    const temporaryDirectory = join(this.rootDirectory, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    const targetDirectory = join(this.rootDirectory, id)
    await mkdir(temporaryDirectory, { mode: DIRECTORY_MODE })
    try {
      const groups = [] as PreparedSnapshotManifest['groups']
      for (const [groupIndex, group] of prepared.groups.entries()) {
        const snapshotGroup = await this.copyGroup(group, groupIndex, temporaryDirectory)
        groups.push(snapshotGroup)
      }
      const manifest: PreparedSnapshotManifest = {
        schemaVersion: CURRENT_PREPARED_SNAPSHOT_SCHEMA_VERSION,
        id,
        name: prepared.name,
        ...(prepared.publisher === undefined ? {} : { publisher: prepared.publisher }),
        destination: prepared.destination,
        configuration: prepared.configuration,
        orderedAssetIds,
        groups,
        conversionVersion: prepared.conversionVersion,
        contentFingerprint: prepared.fingerprint,
        createdAt: this.now().toISOString(),
      }
      assertPreparedSnapshotManifest(manifest)
      const manifestPath = join(temporaryDirectory, 'manifest.json')
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: FILE_MODE,
        flag: 'wx',
      })
      await rename(temporaryDirectory, targetDirectory)
      return { kind: 'saved', manifest }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async list(): Promise<PreparedSnapshotManifest[]> {
    let entries
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
    const manifests: PreparedSnapshotManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SNAPSHOT_ID_PATTERN.test(entry.name)) continue
      try {
        manifests.push(await this.readManifest(entry.name))
      } catch {
        // A corrupt snapshot is never surfaced as a reusable result.
      }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async get(id: string, verifyPayloads = true): Promise<PreparedSnapshotManifest> {
    const manifest = await this.readManifest(id)
    if (verifyPayloads) await this.verifyPayloads(manifest)
    return manifest
  }

  async readPayload(
    snapshotId: string,
    payloadId: string,
  ): Promise<{ contents: Buffer; mimeType: string }> {
    const manifest = await this.get(snapshotId, false)
    const payload = manifest.groups
      .flatMap((group) => group.payloads)
      .find((candidate) => candidate.id === payloadId)
    if (!payload) throw new Error('Snapshot payload not found')
    const path = safePayloadPath(this.rootDirectory, manifest.id, payload.relativePath)
    const contents = await readFile(path)
    if (contents.length !== payload.sizeBytes || sha256(contents) !== payload.sha256) {
      throw new Error('Snapshot payload checksum validation failed')
    }
    return { contents, mimeType: payload.mimeType }
  }

  async delete(id: string): Promise<boolean> {
    assertSnapshotId(id)
    try {
      await stat(join(this.rootDirectory, id))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      throw error
    }
    await rm(join(this.rootDirectory, id), { recursive: true })
    return true
  }

  private async copyGroup(
    group: PreparedExportGroup,
    groupIndex: number,
    temporaryDirectory: string,
  ): Promise<PreparedSnapshotManifest['groups'][number]> {
    const payloads: PreparedSnapshotPayload[] = []
    for (const [payloadIndex, payload] of group.payloads.entries()) {
      const extension = safeExtension(payload.fileName)
      const relativePath = join(
        'payloads',
        String(groupIndex + 1).padStart(3, '0'),
        `${String(payloadIndex + 1).padStart(3, '0')}${extension}`,
      )
      const targetPath = join(temporaryDirectory, relativePath)
      await mkdir(resolve(targetPath, '..'), { recursive: true, mode: DIRECTORY_MODE })
      await copyFile(payload.sourcePath, targetPath)
      await chmod(targetPath, FILE_MODE)
      const copied = await stat(targetPath)
      const checksum = await sha256File(targetPath)
      if (copied.size !== payload.sizeBytes || checksum !== payload.sha256) {
        throw new Error('Prepared payload changed while the snapshot was being saved')
      }
      payloads.push(toSnapshotPayload(payload, relativePath))
    }
    return {
      id: group.id,
      name: group.name,
      mediaKind: group.mediaKind,
      assetIds: [...group.assetIds],
      payloads,
    }
  }

  private async readManifest(id: string): Promise<PreparedSnapshotManifest> {
    assertSnapshotId(id)
    const parsed: unknown = JSON.parse(
      await readFile(join(this.rootDirectory, id, 'manifest.json'), 'utf8'),
    )
    assertPreparedSnapshotManifest(parsed)
    if (parsed.id !== id) throw new Error('Snapshot ID does not match its directory')
    return parsed
  }

  private async verifyPayloads(manifest: PreparedSnapshotManifest): Promise<void> {
    for (const payload of manifest.groups.flatMap((group) => group.payloads)) {
      const path = safePayloadPath(this.rootDirectory, manifest.id, payload.relativePath)
      const file = await stat(path)
      if (file.size !== payload.sizeBytes || (await sha256File(path)) !== payload.sha256) {
        throw new Error('Snapshot payload checksum validation failed')
      }
    }
  }
}

export function toPreparedSnapshotSummary(
  manifest: PreparedSnapshotManifest,
): PreparedSnapshotSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.publisher === undefined ? {} : { publisher: manifest.publisher }),
    destination: manifest.destination,
    assetCount: manifest.orderedAssetIds.length,
    groupCount: manifest.groups.length,
    contentFingerprint: manifest.contentFingerprint,
    createdAt: manifest.createdAt,
  }
}

export function toPreparedSnapshotView(
  manifest: PreparedSnapshotManifest,
  previewUrlForPayload: (snapshotId: string, payloadId: string) => string,
): PreparedSnapshotView {
  return {
    ...toPreparedSnapshotSummary(manifest),
    configuration: manifest.configuration,
    orderedAssetIds: [...manifest.orderedAssetIds],
    groups: manifest.groups.map((group): PreparedExportGroupView => ({
      id: group.id,
      name: group.name,
      mediaKind: group.mediaKind,
      assetIds: [...group.assetIds],
      items: group.payloads
        .filter(
          (payload): payload is PreparedSnapshotPayload & { assetId: string } =>
            payload.role === 'sticker' && payload.assetId !== undefined,
        )
        .map((payload) => ({
          id: payload.id,
          assetId: payload.assetId,
          previewUrl: previewUrlForPayload(manifest.id, payload.id),
          fileName: payload.fileName,
          sizeBytes: payload.sizeBytes,
          animated: payload.animated,
          ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
          ...(payload.animationTimingAdjusted ? { animationTimingAdjusted: true } : {}),
          ...(payload.droppedFrameCount ? { droppedFrameCount: payload.droppedFrameCount } : {}),
        })),
      status: 'prepared',
    })),
    conversionVersion: manifest.conversionVersion,
  }
}

export function assertPreparedSnapshotManifest(
  value: unknown,
): asserts value is PreparedSnapshotManifest {
  if (!isRecord(value) || value.schemaVersion !== CURRENT_PREPARED_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Unsupported prepared snapshot schema')
  }
  assertSnapshotId(value.id)
  assertShortText(value.name, 'snapshot name')
  if (value.publisher !== undefined) assertShortText(value.publisher, 'snapshot publisher')
  if (value.destination !== 'whatsapp' && value.destination !== 'local-folder') {
    throw new Error('Invalid snapshot destination')
  }
  const configuration = value.configuration
  assertConfiguration(configuration, value.destination)
  if (
    (configuration.kind === 'whatsapp' &&
      (value.name !== configuration.title || value.publisher !== configuration.publisher)) ||
    (configuration.kind === 'local-folder' && value.name !== configuration.batchName)
  ) {
    throw new Error('Snapshot name or publisher does not match its configuration')
  }
  const orderedAssetIds = value.orderedAssetIds
  assertStringArray(orderedAssetIds, 'snapshot order')
  if (new Set(orderedAssetIds).size !== orderedAssetIds.length) {
    throw new Error('Snapshot asset order must be unique')
  }
  if (!Array.isArray(value.groups) || value.groups.length === 0 || value.groups.length > 100_000) {
    throw new Error('Snapshot groups are invalid')
  }
  const payloadIds = new Set<string>()
  const stickerIds: string[] = []
  for (const group of value.groups) {
    assertSnapshotGroup(group)
    const stickerCount = group.payloads.filter((payload) => payload.role === 'sticker').length
    const trayCount = group.payloads.filter((payload) => payload.role === 'tray').length
    if (
      value.destination === 'whatsapp' &&
      (group.mediaKind === 'mixed' || stickerCount < 3 || stickerCount > 30 || trayCount !== 1)
    ) {
      throw new Error('Snapshot WhatsApp group does not satisfy delivery rules')
    }
    if (
      value.destination === 'local-folder' &&
      configuration.kind === 'local-folder' &&
      (trayCount !== 0 || stickerCount > configuration.itemsPerFolder)
    ) {
      throw new Error('Snapshot local folder group does not match its grouping rules')
    }
    for (const payload of group.payloads) {
      if (payloadIds.has(payload.id)) throw new Error('Snapshot payload IDs must be unique')
      payloadIds.add(payload.id)
      if (payload.role === 'sticker') stickerIds.push(payload.assetId!)
    }
  }
  if (
    stickerIds.length !== orderedAssetIds.length ||
    new Set(stickerIds).size !== stickerIds.length ||
    stickerIds.some((id) => !orderedAssetIds.includes(id))
  ) {
    throw new Error('Snapshot payloads must contain every ordered asset exactly once')
  }
  assertShortText(value.conversionVersion, 'snapshot conversion version')
  if (
    typeof value.contentFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentFingerprint)
  ) {
    throw new Error('Snapshot fingerprint is invalid')
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Snapshot createdAt is invalid')
  }
}

/**
 * Snapshots persist the successfully prepared subset of the selection: asset-level
 * failures and informational warnings do not block saving, but a failed group has no
 * payloads to represent it and therefore does. Returns the ordered asset IDs covered
 * by sticker payloads, in selection order.
 */
function assertSavablePreparation(prepared: PreparedExportResult): string[] {
  if (
    prepared.groups.length === 0 ||
    prepared.groups.some((group) => group.status !== 'prepared')
  ) {
    throw new Error('存在准备失败的分组，不能保存 snapshot')
  }
  const stickerIds = prepared.groups.flatMap((group) =>
    group.payloads
      .filter(
        (payload): payload is PreparedPayloadInput & { assetId: string } =>
          payload.role === 'sticker' && payload.assetId !== undefined,
      )
      .map((payload) => payload.assetId),
  )
  const preparedIds = new Set(stickerIds)
  const orderedAssetIds = prepared.orderedAssetIds.filter((id) => preparedIds.has(id))
  if (
    orderedAssetIds.length !== stickerIds.length ||
    new Set(orderedAssetIds).size !== orderedAssetIds.length
  ) {
    throw new Error('准备结果与本次选择不一致，不能保存 snapshot')
  }
  return orderedAssetIds
}

function assertSnapshotGroup(
  value: unknown,
): asserts value is PreparedSnapshotManifest['groups'][number] {
  if (!isRecord(value)) throw new Error('Invalid snapshot group')
  assertShortText(value.id, 'snapshot group ID')
  assertShortText(value.name, 'snapshot group name')
  if (!['static', 'animated', 'mixed'].includes(String(value.mediaKind))) {
    throw new Error('Invalid snapshot media kind')
  }
  const assetIds = value.assetIds
  assertStringArray(assetIds, 'snapshot group assets')
  if (!Array.isArray(value.payloads) || value.payloads.length === 0) {
    throw new Error('Snapshot group payloads are invalid')
  }
  value.payloads.forEach(assertSnapshotPayload)
  const stickerAssetIds = value.payloads
    .filter((payload) => payload.role === 'sticker')
    .map((payload) => payload.assetId)
  if (
    stickerAssetIds.length !== assetIds.length ||
    stickerAssetIds.some((assetId) => !assetIds.includes(assetId!))
  ) {
    throw new Error('Snapshot group assets do not match its sticker payloads')
  }
}

function assertSnapshotPayload(value: unknown): asserts value is PreparedSnapshotPayload {
  if (!isRecord(value)) throw new Error('Invalid snapshot payload')
  assertShortText(value.id, 'snapshot payload ID')
  if (value.role !== 'sticker' && value.role !== 'tray') throw new Error('Invalid payload role')
  if (value.role === 'sticker') assertShortText(value.assetId, 'snapshot payload asset ID')
  if (value.role === 'tray' && value.assetId !== undefined) {
    throw new Error('Snapshot tray payload must not reference a library asset')
  }
  assertFileName(value.fileName)
  assertRelativePayloadPath(value.relativePath)
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Invalid snapshot payload checksum')
  }
  if (!Number.isInteger(value.sizeBytes) || (value.sizeBytes as number) < 0) {
    throw new Error('Invalid snapshot payload size')
  }
  assertShortText(value.mimeType, 'snapshot payload MIME type')
  if (typeof value.animated !== 'boolean') throw new Error('Invalid snapshot animation flag')
  if (
    value.durationMs !== undefined &&
    (!Number.isFinite(value.durationMs) || (value.durationMs as number) < 0)
  ) {
    throw new Error('Invalid snapshot payload duration')
  }
  if (
    value.animationTimingAdjusted !== undefined &&
    typeof value.animationTimingAdjusted !== 'boolean'
  ) {
    throw new Error('Invalid snapshot animation repair flag')
  }
  if (
    value.droppedFrameCount !== undefined &&
    (!Number.isInteger(value.droppedFrameCount) || (value.droppedFrameCount as number) < 0)
  ) {
    throw new Error('Invalid snapshot dropped frame count')
  }
}

function assertConfiguration(
  value: unknown,
  destination: string,
): asserts value is PreparedSnapshotConfiguration {
  if (!isRecord(value) || value.kind !== destination)
    throw new Error('Invalid snapshot configuration')
  if (value.kind === 'whatsapp') {
    assertShortText(value.title, 'WhatsApp title')
    assertShortText(value.publisher, 'WhatsApp publisher')
    if (
      !Number.isInteger(value.packSize) ||
      (value.packSize as number) < 3 ||
      (value.packSize as number) > 30
    ) {
      throw new Error('Invalid WhatsApp pack size')
    }
    return
  }
  assertShortText(value.batchName, 'local export batch name')
  if (value.format !== 'original' && value.format !== 'converted-webp') {
    throw new Error('Invalid local export format')
  }
  if (value.naming !== 'original' && value.naming !== 'sequence') {
    throw new Error('Invalid local export naming rule')
  }
  if (
    !Number.isInteger(value.itemsPerFolder) ||
    (value.itemsPerFolder as number) < 1 ||
    (value.itemsPerFolder as number) > 10_000
  ) {
    throw new Error('Invalid local export group size')
  }
}

function toSnapshotPayload(
  payload: PreparedPayloadInput,
  relativePath: string,
): PreparedSnapshotPayload {
  return {
    id: payload.id,
    role: payload.role,
    ...(payload.assetId === undefined ? {} : { assetId: payload.assetId }),
    fileName: payload.fileName,
    relativePath,
    sha256: payload.sha256,
    sizeBytes: payload.sizeBytes,
    mimeType: payload.mimeType,
    animated: payload.animated,
    ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
    ...(payload.animationTimingAdjusted ? { animationTimingAdjusted: true } : {}),
    ...(payload.droppedFrameCount ? { droppedFrameCount: payload.droppedFrameCount } : {}),
  }
}

function safePayloadPath(root: string, snapshotId: string, relativePath: string): string {
  assertRelativePayloadPath(relativePath)
  const snapshotDirectory = join(root, snapshotId)
  const path = resolve(snapshotDirectory, relativePath)
  if (!path.startsWith(`${snapshotDirectory}${sep}`))
    throw new Error('Invalid snapshot payload path')
  return path
}

function assertRelativePayloadPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !value.startsWith(`payloads${sep}`) ||
    isAbsolute(value) ||
    value.split(/[\\/]/).includes('..')
  ) {
    throw new Error('Invalid snapshot relative payload path')
  }
}

function assertSnapshotId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SNAPSHOT_ID_PATTERN.test(value)) {
    throw new Error('Invalid snapshot ID')
  }
}

function assertFileName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 160 ||
    basename(value) !== value ||
    value.includes('\0')
  ) {
    throw new Error('Invalid snapshot payload file name')
  }
}

function assertShortText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((item) => typeof item !== 'string' || !item)
  ) {
    throw new Error(`Invalid ${label}`)
  }
}

function safeExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
